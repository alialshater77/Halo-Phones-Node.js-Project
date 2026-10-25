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
const brevoKey = readConfig('BREVO_API_KEY');
const resendKey = readConfig('RESEND_API_KEY');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 20000,
  auth: {
    user: mailUser,
    pass: mailPass
  }
});

function sendWithBrevo(message) {
  return fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': brevoKey
    },
    body: JSON.stringify({
      sender: { name: 'Halo Phones', email: mailUser },
      to: [{ email: message.to }],
      subject: message.subject,
      htmlContent: message.html
    })
  }).then(response => {
    if (response.ok) {
      return;
    }
    return response.text().then(text => {
      throw new Error('Email was not sent. ' + text);
    });
  });
}

function sendWithResend(message) {
  const from = readConfig('MAIL_FROM') || 'Halo Phones <onboarding@resend.dev>';
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + resendKey,
      'Content-Type': 'application/json',
      'User-Agent': 'HaloPhones/1.0'
    },
    body: JSON.stringify({
      from: from,
      to: [message.to],
      subject: message.subject,
      html: message.html
    })
  }).then(response => {
    if (response.ok) {
      return;
    }
    return response.text().then(text => {
      throw new Error('Email was not sent. ' + text);
    });
  });
}

function sendMail(message) {
  if (!message || !message.to) {
    return Promise.reject(new Error('Missing email recipient.'));
  }
  if (resendKey) {
    return sendWithResend(message);
  }
  if (brevoKey) {
    return sendWithBrevo(message);
  }
  if (!mailUser || !mailPass) {
    return Promise.reject(new Error('MAIL_USER or MAIL_PASS is missing.'));
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
