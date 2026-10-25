const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PDFDocument = require('pdfkit');

const Product = require('../models/product');
const Order = require('../models/order');
const PendingPayment = require('../models/pending-payment');
const User = require('../models/user');
const { sendOrderEmail } = require('../util/mail');
const { cacheGet, cacheSet, readCatalog, writeCatalog, invalidateProducts } = require('../util/redis');

function readConfig(name) {
  if (process.env[name]) {
    return process.env[name];
  }
  try {
    return (require('../nodemon.json').env || {})[name] || '';
  } catch (err) {
    return '';
  }
}

const stripe = require('stripe')(readConfig('STRIPE_KEY'));
const appUrl = (readConfig('APP_URL') || 'http://localhost:3000').replace(/\/$/, '');

function cartSnapshot(items) {
  const products = items
    .filter(item => item.productId)
    .map(item => ({
      quantity: item.quantity,
      product: { ...item.productId._doc }
    }))
    .sort((a, b) => String(a.product._id).localeCompare(String(b.product._id)));

  let amount = 0;
  products.forEach(item => {
    amount += Math.round(Number(item.product.price) * 100) * item.quantity;
  });

  const cartHash = crypto
    .createHash('sha256')
    .update(
      products
        .map(item => item.product._id + ':' + item.quantity + ':' + item.product.price)
        .join('|')
    )
    .digest('hex');

  return { products, amount, cartHash };
}

function removePaidItems(pending) {
  return User.findById(pending.userId).then(user => {
    if (!user) {
      return;
    }
    const nextItems = [];
    user.cart.items.forEach(item => {
      const paid = pending.products.find(
        entry => String(entry.product._id) === item.productId.toString()
      );
      if (!paid) {
        nextItems.push(item);
        return;
      }
      const remaining = item.quantity - paid.quantity;
      if (remaining > 0) {
        item.quantity = remaining;
        nextItems.push(item);
      }
    });
    user.cart.items = nextItems;
    return user.save();
  });
}

function fulfillPayment(paymentIntentId, actingUserId) {
  return stripe.paymentIntents.retrieve(paymentIntentId).then(paymentIntent => {
    if (!paymentIntent || paymentIntent.status !== 'succeeded') {
      return { status: 'not_paid' };
    }
    if (actingUserId && paymentIntent.metadata.userId !== String(actingUserId)) {
      return { status: 'forbidden' };
    }
    return Order.findOne({ 'payment.paymentIntentId': paymentIntent.id }).then(existing => {
      if (existing) {
        return PendingPayment.findOne({ paymentIntentId: paymentIntent.id }).then(pending => {
          if (!pending) {
            return { status: 'exists', order: existing };
          }
          return removePaidItems(pending).then(() => {
            return PendingPayment.deleteOne({ paymentIntentId: paymentIntent.id }).then(() => {
              return { status: 'exists', order: existing };
            });
          });
        });
      }
      return PendingPayment.findOne({ paymentIntentId: paymentIntent.id }).then(pending => {
        if (!pending || pending.amount !== paymentIntent.amount) {
          return { status: 'missing' };
        }
        if (pending.userId.toString() !== paymentIntent.metadata.userId) {
          return { status: 'forbidden' };
        }
        const order = new Order({
          products: pending.products,
          user: {
            email: pending.email,
            userId: pending.userId
          },
          payment: { paymentIntentId: paymentIntent.id, status: 'paid' }
        });
        return order
          .save()
          .then(saved => {
            return removePaidItems(pending)
              .then(() => reduceStock(pending))
              .then(() => invalidateProducts(pending.products.map(item => item.product && item.product._id)))
              .then(() => PendingPayment.deleteOne({ paymentIntentId: paymentIntent.id }))
              .then(() => sendOrderEmail(saved))
              .then(() => {
                return { status: 'created', order: saved };
              });
          })
          .catch(err => {
            if (err && err.code === 11000) {
              return Order.findOne({ 'payment.paymentIntentId': paymentIntent.id }).then(orderDoc => {
                return { status: 'exists', order: orderDoc };
              });
            }
            throw err;
          });
      });
    });
  });
}

function reduceStock(pending) {
  return Promise.all(
    pending.products.map(item => {
      const id = item.product && item.product._id;
      if (!id) {
        return Promise.resolve();
      }
      return Product.updateOne(
        { _id: id, stock: { $gte: item.quantity } },
        { $inc: { stock: -item.quantity } }
      );
    })
  );
}

const ITEMS_PER_PAGE = 6;

function catalogFilter(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const search = String(query.search || '').trim().slice(0, 80);
  const minPrice = query.minPrice === undefined || query.minPrice === '' ? null : Number(query.minPrice);
  const maxPrice = query.maxPrice === undefined || query.maxPrice === '' ? null : Number(query.maxPrice);
  const filter = {};
  if (search) {
    filter.title = {
      $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      $options: 'i'
    };
  }
  const price = {};
  if (Number.isFinite(minPrice) && minPrice >= 0) {
    price.$gte = minPrice;
  }
  if (Number.isFinite(maxPrice) && maxPrice >= 0) {
    price.$lte = maxPrice;
  }
  if (Object.keys(price).length) {
    filter.price = price;
  }
  const params = new URLSearchParams();
  if (search) {
    params.set('search', search);
  }
  if (price.$gte !== undefined) {
    params.set('minPrice', String(price.$gte));
  }
  if (price.$lte !== undefined) {
    params.set('maxPrice', String(price.$lte));
  }
  return {
    page: page,
    filter: filter,
    filterQuery: params.toString(),
    filters: {
      search: search,
      minPrice: price.$gte === undefined ? null : price.$gte,
      maxPrice: price.$lte === undefined ? null : price.$lte
    }
  };
}

function renderCatalog(req, res, next, view, pageTitle, path) {
  const catalog = catalogFilter(req.query);
  const sendPage = (products, totalItems) => {
    const lastPage = Math.max(1, Math.ceil(totalItems / ITEMS_PER_PAGE));
    res.render(view, {
      prods: products,
      pageTitle: pageTitle,
      path: path,
      currentPage: catalog.page,
      hasNextPage: ITEMS_PER_PAGE * catalog.page < totalItems,
      hasPreviousPage: catalog.page > 1,
      nextPage: catalog.page + 1,
      previousPage: catalog.page - 1,
      lastPage: lastPage,
      filters: catalog.filters,
      filterQuery: catalog.filterQuery
    });
  };

  readCatalog(catalog)
    .then(cached => {
      if (cached) {
        return sendPage(cached.products, cached.totalItems);
      }
      let totalItems;
      return Product.find(catalog.filter)
        .countDocuments()
        .then(numProducts => {
          totalItems = numProducts;
          return Product.find(catalog.filter)
            .skip((catalog.page - 1) * ITEMS_PER_PAGE)
            .limit(ITEMS_PER_PAGE)
            .lean();
        })
        .then(products => {
          return writeCatalog(catalog, { products: products, totalItems: totalItems }).then(() => {
            sendPage(products, totalItems);
          });
        });
    })
    .catch(err => {
      const error = new Error(err);
      error.httpStatusCode = 500;
      return next(error);
    });
}

exports.getProducts = (req, res, next) => {
  renderCatalog(req, res, next, 'shop/product-list', 'Products', '/products');
};

exports.getProduct = (req, res, next) => {
  const prodId = req.params.productId;
  const showProduct = product => {
    const message = req.flash('error');
    res.render('shop/product-detail', {
      product: product,
      pageTitle: product.title,
      path: '/products',
      errorMessage: message.length ? message[0] : null
    });
  };
  cacheGet('product:' + prodId)
    .then(cached => {
      if (cached) {
        return showProduct(cached);
      }
      return Product.findById(prodId)
        .lean()
        .then(product => {
          if (!product) {
            return res.status(404).render('404', {
              pageTitle: 'Page Not Found',
              path: '/404'
            });
          }
          return cacheSet('product:' + prodId, product, 120).then(() => showProduct(product));
        });
    })
    .catch(err => {
      if (err.name === 'CastError') {
        return res.status(404).render('404', {
          pageTitle: 'Page Not Found',
          path: '/404'
        });
      }
      const error = new Error(err);
      error.httpStatusCode = 500;
      return next(error);
    });
};

exports.getIndex = (req, res, next) => {
  renderCatalog(req, res, next, 'shop/index', 'Shop', '/');
};

exports.getCart = (req, res, next) => {
  req.user
    .populate('cart.items.productId')
    .then(user => {
      const products = user.cart.items.filter(item => item.productId);
      if (products.length === user.cart.items.length) {
        return res.render('shop/cart', {
          path: '/cart',
          pageTitle: 'Your Cart',
          products: products
        });
      }
      user.cart.items = products.map(item => ({
        productId: item.productId._id,
        quantity: item.quantity
      }));
      return user.save().then(() => {
        res.render('shop/cart', {
          path: '/cart',
          pageTitle: 'Your Cart',
          products: products
        });
      });
    })
    .catch(err => {
      const error = new Error(err);
      error.httpStatusCode = 500;
      return next(error);
    });
};

exports.postCart = (req, res, next) => {
  const prodId = req.body.productId;
  const quantity = req.body.quantity;
  Product.findById(prodId)
    .then(product => {
      if (!product) {
        return res.redirect('/');
      }
      return req.user.addToCart(product, quantity);
    })
    .then(result => {
      if (res.headersSent) {
        return;
      }
      res.redirect('/cart');
    })
    .catch(err => {
      if (err && err.statusCode === 422) {
        req.flash('error', err.message);
        return res.redirect('/products/' + prodId);
      }
      const error = new Error(err);
      error.httpStatusCode = 500;
      return next(error);
    });
};

exports.postCartDeleteProduct = (req, res, next) => {
  const prodId = req.body.productId;
  req.user
    .removeFromCart(prodId)
    .then(result => {
      res.redirect('/cart');
    })
    .catch(err => {
      const error = new Error(err);
      error.httpStatusCode = 500;
      return next(error);
    });
};

exports.getCheckout = (req, res, next) => {
  let viewItems = [];
  let totalSum = 0;

  const renderCheckout = (status, extras) => {
    if (res.headersSent) {
      return;
    }
    return res.status(status).render('shop/checkout', Object.assign({
      path: '/checkout',
      pageTitle: 'Checkout',
      products: viewItems,
      totalSum: totalSum,
      errorMessage: null,
      clientSecret: null,
      publishableKey: '',
      returnUrl: ''
    }, extras));
  };

  req.user
    .populate('cart.items.productId')
    .then(user => {
      viewItems = user.cart.items.filter(item => item.productId);
      if (!viewItems.length) {
        return res.redirect('/cart');
      }
      const snapshot = cartSnapshot(viewItems);
      totalSum = snapshot.amount / 100;
      if (snapshot.amount < 50) {
        return renderCheckout(422, {
          errorMessage: 'The order total must be at least $0.50.'
        });
      }
      const short = viewItems.find(item => {
        return typeof item.productId.stock === 'number' && item.quantity > item.productId.stock;
      });
      if (short) {
        return renderCheckout(422, {
          errorMessage: short.productId.title + ' does not have enough stock.'
        });
      }
      const publishableKey = readConfig('STRIPE_PUBLISHABLE_KEY');
      if (!readConfig('STRIPE_KEY') || !publishableKey) {
        return renderCheckout(500, {
          errorMessage: 'Card payments are not configured.'
        });
      }

      const paymentParams = {
        amount: snapshot.amount,
        currency: 'usd',
        receipt_email: req.user.email,
        metadata: {
          userId: req.user._id.toString(),
          cartHash: snapshot.cartHash
        },
        automatic_payment_methods: { enabled: true }
      };
      const idempotencyKey = 'pay_' + req.user._id.toString() + '_' + snapshot.cartHash;

      return stripe.paymentIntents
        .create(paymentParams, { idempotencyKey: idempotencyKey })
        .then(paymentIntent => {
          if (paymentIntent.status === 'canceled') {
            return stripe.paymentIntents.create(paymentParams, {
              idempotencyKey: idempotencyKey + '_retry'
            });
          }
          return paymentIntent;
        })
        .then(paymentIntent => {
          if (paymentIntent.status === 'succeeded') {
            return fulfillPayment(paymentIntent.id, req.user._id).then(result => {
              if (result.status === 'created' || result.status === 'exists') {
                return res.redirect('/orders');
              }
              return renderCheckout(422, {
                errorMessage: 'This payment already succeeded. Refresh the orders page before paying again.'
              });
            });
          }
          if (paymentIntent.status === 'processing') {
            return renderCheckout(422, {
              errorMessage: 'The payment is still processing. Refresh this page in a moment.'
            });
          }
          return PendingPayment.findOneAndUpdate(
            { paymentIntentId: paymentIntent.id },
            {
              paymentIntentId: paymentIntent.id,
              userId: req.user._id,
              email: req.user.email,
              amount: snapshot.amount,
              cartHash: snapshot.cartHash,
              products: snapshot.products
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
          ).then(() => {
            return renderCheckout(200, {
              clientSecret: paymentIntent.client_secret,
              publishableKey: publishableKey,
              returnUrl: appUrl + '/checkout/success'
            });
          });
        });
    })
    .catch(err => {
      if (res.headersSent) {
        return;
      }
      const stripeMessage = err && err.raw && err.raw.message
        ? err.raw.message
        : err && err.type
          ? err.message
          : '';
      if (stripeMessage) {
        return renderCheckout(422, { errorMessage: stripeMessage });
      }
      const error = new Error(err);
      error.httpStatusCode = 500;
      return next(error);
    });
};

exports.getCheckoutSuccess = (req, res, next) => {
  const paymentIntentId = req.query.payment_intent;
  if (!paymentIntentId) {
    return res.redirect('/checkout');
  }
  fulfillPayment(paymentIntentId, req.user._id)
    .then(result => {
      if (result.status === 'created' || result.status === 'exists') {
        if (result.order.user.userId.toString() !== req.user._id.toString()) {
          return res.redirect('/');
        }
        return res.redirect('/orders');
      }
      return res.redirect('/checkout');
    })
    .catch(err => {
      const error = new Error(err);
      error.httpStatusCode = 500;
      return next(error);
    });
};

exports.getOrders = (req, res, next) => {
  Order.find({ 'user.userId': req.user._id })
    .then(orders => {
      res.render('shop/orders', {
        path: '/orders',
        pageTitle: 'Your Orders',
        orders: orders
      });
    })
    .catch(err => {
      const error = new Error(err);
      error.httpStatusCode = 500;
      return next(error);
    });
};

function money(amount) {
  return '$' + Number(amount || 0).toFixed(2);
}

function writeInvoice(doc, order, orderId) {
  const pageWidth = doc.page.width;
  const left = 48;
  const right = pageWidth - 48;
  const contentWidth = right - left;
  const ink = '#17140f';
  const pine = '#1d4a42';
  const gold = '#e7b15a';
  const cream = '#f6f1e8';
  const paper = '#f3ecdf';
  const muted = '#5c564c';
  const placed = order._id.getTimestamp();
  const dateLabel = placed.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });
  const invoiceNo = 'INV-' + String(orderId).slice(-8).toUpperCase();
  const cols = {
    item: left + 12,
    qty: left + 292,
    price: left + 348,
    amount: left + 418
  };
  const amountWidth = contentWidth - (cols.amount - left) - 12;

  doc.rect(0, 0, pageWidth, 126).fill(pine);
  doc.fillColor(gold).font('Helvetica-Bold').fontSize(11)
    .text('HALO PHONES', left, 36, { lineBreak: false });
  doc.fillColor(cream).font('Helvetica').fontSize(11)
    .text('A small shelf of handsets.', left, 56, { lineBreak: false });
  doc.fillColor(cream).font('Helvetica-Bold').fontSize(26)
    .text('Invoice', left, 38, { width: contentWidth, align: 'right' });
  doc.fillColor(gold).font('Helvetica').fontSize(11)
    .text(invoiceNo, left, 72, { width: contentWidth, align: 'right' });

  let y = 154;
  doc.fillColor(muted).font('Helvetica-Bold').fontSize(9);
  doc.text('BILL TO', left, y, { lineBreak: false });
  doc.text('ORDER', left + 230, y, { lineBreak: false });
  doc.text('DATE', left + 390, y, { lineBreak: false });

  y += 16;
  doc.fillColor(ink).font('Helvetica').fontSize(12)
    .text(order.user.email, left, y, { width: 210 });
  const afterEmail = doc.y;
  doc.fontSize(11).text(String(orderId), left + 230, y, { width: 150 });
  doc.text(dateLabel, left + 390, y, { width: contentWidth - 390 });
  y = Math.max(afterEmail, doc.y) + 28;

  doc.rect(left, y, contentWidth, 28).fill(ink);
  doc.fillColor(cream).font('Helvetica-Bold').fontSize(9);
  doc.text('ITEM', cols.item, y + 9, { lineBreak: false });
  doc.text('QTY', cols.qty, y + 9, { width: 46, align: 'right' });
  doc.text('PRICE', cols.price, y + 9, { width: 60, align: 'right' });
  doc.text('AMOUNT', cols.amount, y + 9, { width: amountWidth, align: 'right' });
  y += 28;

  let totalPrice = 0;
  order.products.forEach((prod, index) => {
    const title = prod.product.title || 'Item';
    const description = String(prod.product.description || '').replace(/\s+/g, ' ').trim();
    const shortDesc = description.length > 140 ? description.slice(0, 139) + '...' : description;
    const qty = prod.quantity;
    const price = Number(prod.product.price) || 0;
    const lineTotal = qty * price;
    totalPrice += lineTotal;

    doc.font('Helvetica-Bold').fontSize(11);
    const titleHeight = doc.heightOfString(title, { width: 250 });
    doc.font('Helvetica').fontSize(9);
    const descHeight = shortDesc ? doc.heightOfString(shortDesc, { width: 250 }) : 0;
    const rowHeight = Math.max(48, 16 + titleHeight + (shortDesc ? 4 + descHeight : 0) + 10);

    if (y + rowHeight > doc.page.height - 150) {
      doc.addPage();
      y = 48;
    }

    if (index % 2 === 0) {
      doc.rect(left, y, contentWidth, rowHeight).fill(paper);
    }

    doc.fillColor(ink).font('Helvetica-Bold').fontSize(11)
      .text(title, cols.item, y + 12, { width: 250 });
    if (shortDesc) {
      doc.fillColor(muted).font('Helvetica').fontSize(9)
        .text(shortDesc, cols.item, y + 14 + titleHeight, { width: 250 });
    }
    doc.fillColor(ink).font('Helvetica').fontSize(11);
    doc.text(String(qty), cols.qty, y + 12, { width: 46, align: 'right' });
    doc.text(money(price), cols.price, y + 12, { width: 60, align: 'right' });
    doc.text(money(lineTotal), cols.amount, y + 12, { width: amountWidth, align: 'right' });
    y += rowHeight;
  });

  y += 18;
  if (y + 90 > doc.page.height - 80) {
    doc.addPage();
    y = 48;
  }

  const boxWidth = 220;
  const boxX = right - boxWidth;
  doc.rect(boxX, y, boxWidth, 68).fill(pine);
  doc.fillColor(gold).font('Helvetica-Bold').fontSize(9)
    .text('TOTAL DUE', boxX + 16, y + 14, { lineBreak: false });
  doc.fillColor(cream).font('Helvetica-Bold').fontSize(20)
    .text(money(totalPrice), boxX + 16, y + 32, { width: boxWidth - 32, align: 'right' });

  doc.fillColor(muted).font('Helvetica').fontSize(9)
    .text(
      'Thank you for your order. Keep this invoice for your records.',
      left,
      doc.page.height - 60,
      { width: contentWidth }
    );
}

exports.getInvoice = (req, res, next) => {
  const orderId = req.params.orderId;
  Order.findById(orderId)
    .then(order => {
      if (!order) {
        return next(new Error('No order found.'));
      }
      if (order.user.userId.toString() !== req.user._id.toString()) {
        return next(new Error('Unauthorized'));
      }
      const invoiceName = 'invoice-' + orderId + '.pdf';
      const invoiceDir = path.join(__dirname, '..', 'data', 'invoices');
      fs.mkdirSync(invoiceDir, { recursive: true });
      const invoicePath = path.join(invoiceDir, invoiceName);

      const pdfDoc = new PDFDocument({
        size: 'A4',
        margin: 48,
        info: {
          Title: 'Halo Phones invoice ' + orderId,
          Author: 'Halo Phones'
        }
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        'inline; filename="' + invoiceName + '"'
      );
      res.setHeader('Cache-Control', 'no-store');
      const invoiceFile = fs.createWriteStream(invoicePath);
      invoiceFile.on('error', err => {
        console.log(err);
      });
      pdfDoc.pipe(invoiceFile);
      pdfDoc.pipe(res);
      writeInvoice(pdfDoc, order, orderId);

      pdfDoc.end();
      // fs.readFile(invoicePath, (err, data) => {
      //   if (err) {
      //     return next(err);
      //   }
      //   res.setHeader('Content-Type', 'application/pdf');
      //   res.setHeader(
      //     'Content-Disposition',
      //     'inline; filename="' + invoiceName + '"'
      //   );
      //   res.send(data);
      // });
      // const file = fs.createReadStream(invoicePath);

      // file.pipe(res);
    })
    .catch(err => next(err));
};
