const nodemailer = require('nodemailer');

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

const mailUser = readConfig('MAIL_USER');
const mailPass = readConfig('MAIL_PASS').replace(/\s+/g, '');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  auth: {
    user: mailUser,
    pass: mailPass
  }
});

function sendOrderEmail(order) {
  if (!mailUser || !mailPass || !order || !order.user || !order.user.email) {
    return Promise.resolve();
  }
  const lines = order.products
    .map(item => {
      const line = item.quantity * Number(item.product.price || 0);
      return '<li>' + item.product.title + ' × ' + item.quantity + ' — $' + line.toFixed(2) + '</li>';
    })
    .join('');
  const total = order.products.reduce((sum, item) => {
    return sum + item.quantity * Number(item.product.price || 0);
  }, 0);
  return transporter.sendMail({
    to: order.user.email,
    from: mailUser,
    subject: 'Your Halo Phones order is paid',
    html:
      '<div style="font-family:Arial,sans-serif;color:#17140f;">' +
      '<h1>Payment received</h1>' +
      '<p>Status: Paid</p>' +
      '<ul>' + lines + '</ul>' +
      '<p><strong>Total $' + total.toFixed(2) + '</strong></p>' +
      '</div>'
  }).catch(err => {
    console.log(err);
  });
}

module.exports = {
  sendOrderEmail: sendOrderEmail
};
