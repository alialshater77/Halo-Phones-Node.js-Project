const mongoose = require('mongoose');

const fileHelper = require('../util/file');

const { validationResult } = require('express-validator');

const Product = require('../models/product');
const User = require('../models/user');
const { resizeUpload } = require('../util/image');
const { invalidateProducts } = require('../util/redis');

exports.getAddProduct = (req, res, next) => {
  res.render('admin/edit-product', {
    pageTitle: 'Add Product',
    path: '/admin/add-product',
    editing: false,
    hasError: false,
    errorMessage: null,
    validationErrors: []
  });
};

exports.postAddProduct = (req, res, next) => {
  const title = req.body.title;
  const image = req.file;
  const price = req.body.price;
  const description = req.body.description;
  const stock = req.body.stock;
  if (!image) {
    return res.status(422).render('admin/edit-product', {
      pageTitle: 'Add Product',
      path: '/admin/add-product',
      editing: false,
      hasError: true,
      product: {
        title: title,
        price: price,
        description: description,
        stock: stock
      },
      errorMessage: 'Attached file is not an image.',
      validationErrors: []
    });
  }
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    console.log(errors.array());
    return res.status(422).render('admin/edit-product', {
      pageTitle: 'Add Product',
      path: '/admin/add-product',
      editing: false,
      hasError: true,
      product: {
        title: title,
        price: price,
        description: description,
        stock: stock
      },
      errorMessage: errors.array()[0].msg,
      validationErrors: errors.array()
    });
  }

  const imageUrl = 'images/' + image.filename;

  return resizeUpload(image.path)
    .then(() => {
      const product = new Product({
        title: title,
        price: price,
        description: description,
        stock: stock,
        imageUrl: imageUrl,
        userId: req.user
      });
      return product.save();
    })
    .then(result => {
      console.log('Created Product');
      return invalidateProducts([result._id]).then(() => {
        res.redirect('/admin/products');
      });
    })
    .catch(err => {
      // return res.status(500).render('admin/edit-product', {
      //   pageTitle: 'Add Product',
      //   path: '/admin/add-product',
      //   editing: false,
      //   hasError: true,
      //   product: {
      //     title: title,
      //     imageUrl: imageUrl,
      //     price: price,
      //     description: description
      //   },
      //   errorMessage: 'Database operation failed, please try again.',
      //   validationErrors: []
      // });
      // res.redirect('/500');
      const error = new Error(err);
      error.httpStatusCode = 500;
      return next(error);
    });
};

exports.getEditProduct = (req, res, next) => {
  const editMode = req.query.edit;
  if (!editMode) {
    return res.redirect('/');
  }
  const prodId = req.params.productId;
  Product.findById(prodId)
    .then(product => {
      if (!product) {
        return res.redirect('/');
      }
      res.render('admin/edit-product', {
        pageTitle: 'Edit Product',
        path: '/admin/edit-product',
        editing: editMode,
        product: product,
        hasError: false,
        errorMessage: null,
        validationErrors: []
      });
    })
    .catch(err => {
      const error = new Error(err);
      error.httpStatusCode = 500;
      return next(error);
    });
};

exports.postEditProduct = (req, res, next) => {
  const prodId = req.body.productId;
  const updatedTitle = req.body.title;
  const updatedPrice = req.body.price;
  const image = req.file;
  const updatedDesc = req.body.description;
  const updatedStock = req.body.stock;

  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return Product.findById(prodId)
      .then(existing => {
        return res.status(422).render('admin/edit-product', {
          pageTitle: 'Edit Product',
          path: '/admin/edit-product',
          editing: true,
          hasError: true,
          product: {
            title: updatedTitle,
            price: updatedPrice,
            description: updatedDesc,
            stock: updatedStock,
            _id: prodId,
            imageUrl: existing ? existing.imageUrl : ''
          },
          errorMessage: errors.array()[0].msg,
          validationErrors: errors.array()
        });
      })
      .catch(err => {
        const error = new Error(err);
        error.httpStatusCode = 500;
        return next(error);
      });
  }

  Product.findById(prodId)
    .then(product => {
      if (!product) {
        return res.redirect('/');
      }
      if (product.userId.toString() !== req.user._id.toString()) {
        return res.redirect('/');
      }
      product.title = updatedTitle;
      product.price = updatedPrice;
      product.description = updatedDesc;
      product.stock = updatedStock;
      if (image) {
        fileHelper.deleteFile(product.imageUrl);
        product.imageUrl = 'images/' + image.filename;
      }
      const resized = image ? resizeUpload(image.path) : Promise.resolve();
      return resized.then(() => product.save()).then(result => {
        console.log('UPDATED PRODUCT!');
        return invalidateProducts([product._id]).then(() => {
          res.redirect('/admin/products');
        });
      });
    })
    .catch(err => {
      const error = new Error(err);
      error.httpStatusCode = 500;
      return next(error);
    });
};

exports.getProducts = (req, res, next) => {
  Product.find({ userId: req.user._id })
    // .select('title price -_id')
    // .populate('userId', 'name')
    .then(products => {
      console.log(products);
      res.render('admin/products', {
        prods: products,
        pageTitle: 'Admin Products',
        path: '/admin/products'
      });
    })
    .catch(err => {
      const error = new Error(err);
      error.httpStatusCode = 500;
      return next(error);
    });
};

exports.deleteProduct = (req, res, next) => {
  const prodId = req.params.productId;
  Product.findById(prodId)
    .then(product => {
      if (!product) {
        return res.status(404).json({ message: 'Product not found.' });
      }
      if (product.userId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: 'Not allowed.' });
      }
      fileHelper.deleteFile(product.imageUrl);
      return Product.deleteOne({ _id: prodId, userId: req.user._id }).then(() => {
        return User.updateMany(
          { 'cart.items.productId': product._id },
          { $pull: { 'cart.items': { productId: product._id } } }
        ).then(() => invalidateProducts([product._id]));
      });
    })
    .then(() => {
      if (res.headersSent) {
        return;
      }
      console.log('DESTROYED PRODUCT');
      res.status(200).json({ message: 'Success!' });
    })
    .catch(err => {
      res.status(500).json({ message: 'Deleting product failed.' });
    });
};
