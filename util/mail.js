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
  secure: false,
  requireTLS: true,
  connectionTimeout: 20000,
  greetingTimeout: 20000,
  socketTimeout: 20000,
  auth: {
    user: mailUser,
    pass: mailPass
  }
});

function sendMail(message) {
  if (!mailUser || !mailPass) {
    return Promise.reject(new Error('MAIL_USER or MAIL_PASS is missing.'));
  }
  if (!message || !message.to) {
    return Promise.reject(new Error('Missing email recipient.'));
  }
  return transporter.sendMail({
    to: message.to,
    from: mailUser,
    subject: message.subject,
    html: message.html
  });
}

function sendOrderEmail(order) {
  if (!order || !order.user || !order.user.email) {
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
  return sendMail({
    to: order.user.email,
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
  sendMail: sendMail,
  sendOrderEmail: sendOrderEmail
};
