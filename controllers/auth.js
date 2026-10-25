const crypto = require('crypto');

const bcrypt = require('bcryptjs');
const { validationResult } = require('express-validator');

const User = require('../models/user');
const { sendMail } = require('../util/mail');

function readMailEnv(name) {
  if (process.env[name]) {
    return process.env[name];
  }
  try {
    const devEnv = require('../nodemon.json').env || {};
    return devEnv[name] || '';
  } catch (err) {
    return '';
  }
}

const mailUser = readMailEnv('MAIL_USER');
const appUrl = readMailEnv('APP_URL') || 'http://localhost:3000';

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function isProtectedAdmin(email) {
  return String(email || '').trim().toLowerCase() === 'admin@admin.com';
}

exports.getLogin = (req, res, next) => {
  let message = req.flash('error');
  if (message.length > 0) {
    message = message[0];
  } else {
    message = null;
  }
  res.render('auth/login', {
    path: '/login',
    pageTitle: 'Login',
    errorMessage: message,
    oldInput: {
      email: '',
      password: ''
    },
    validationErrors: []
  });
};

exports.getSignup = (req, res, next) => {
  let message = req.flash('error');
  if (message.length > 0) {
    message = message[0];
  } else {
    message = null;
  }
  res.render('auth/signup', {
    path: '/signup',
    pageTitle: 'Signup',
    errorMessage: message,
    oldInput: {
      email: '',
      password: '',
      confirmPassword: ''
    },
    validationErrors: []
  });
};

exports.postLogin = (req, res, next) => {
  const email = req.body.email;
  const password = req.body.password;

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).render('auth/login', {
      path: '/login',
      pageTitle: 'Login',
      errorMessage: errors.array()[0].msg,
      oldInput: {
        email: email,
        password: password
      },
      validationErrors: errors.array()
    });
  }

  User.findOne({ email: email })
    .then(user => {
      if (!user) {
        return res.status(422).render('auth/login', {
          path: '/login',
          pageTitle: 'Login',
          errorMessage: 'Invalid email or password.',
          oldInput: {
            email: email,
            password: password
          },
          validationErrors: []
        });
      }
      bcrypt
        .compare(password, user.password)
        .then(doMatch => {
          if (doMatch) {
            req.session.isLoggedIn = true;
            req.session.user = { _id: user._id };
            return req.session.save(err => {
              console.log(err);
              res.redirect('/');
            });
          }
          return res.status(422).render('auth/login', {
            path: '/login',
            pageTitle: 'Login',
            errorMessage: 'Invalid email or password.',
            oldInput: {
              email: email,
              password: password
            },
            validationErrors: []
          });
        })
        .catch(err => {
          console.log(err);
          res.redirect('/login');
        });
    })
    .catch(err => {
      const error = new Error(err);
      error.httpStatusCode = 500;
      return next(error);
    });
};

exports.postSignup = (req, res, next) => {
  const email = req.body.email;
  const password = req.body.password;

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    console.log(errors.array());
    return res.status(422).render('auth/signup', {
      path: '/signup',
      pageTitle: 'Signup',
      errorMessage: errors.array()[0].msg,
      oldInput: {
        email: email,
        password: password,
        confirmPassword: req.body.confirmPassword
      },
      validationErrors: errors.array()
    });
  }

  bcrypt
    .hash(password, 12)
    .then(hashedPassword => {
      const user = new User({
        email: email,
        password: hashedPassword,
        isAdmin: false,
        cart: { items: [] }
      });
      return user.save();
    })
    .then(result => {
      res.redirect('/login');
      // return transporter.sendMail({
      //   to: email,
      //   from: 'shop@node-complete.com',
      //   subject: 'Signup succeeded!',
      //   html: '<h1>You successfully signed up!</h1>'
      // });
    })
    .catch(err => {
      if (err && err.code === 11000) {
        return res.status(422).render('auth/signup', {
          path: '/signup',
          pageTitle: 'Signup',
          errorMessage: 'E-Mail exists already, please pick a different one.',
          oldInput: {
            email: email,
            password: password,
            confirmPassword: req.body.confirmPassword
          },
          validationErrors: [{ path: 'email', msg: 'E-Mail exists already, please pick a different one.' }]
        });
      }
      const error = new Error(err);
      error.httpStatusCode = 500;
      return next(error);
    });
};

exports.postLogout = (req, res, next) => {
  req.session.destroy(err => {
    console.log(err);
    res.redirect('/');
  });
};

exports.getReset = (req, res, next) => {
  let message = req.flash('error');
  if (message.length > 0) {
    message = message[0];
  } else {
    message = null;
  }
  res.render('auth/reset', {
    path: '/reset',
    pageTitle: 'Reset Password',
    errorMessage: message,
    successMessage: null,
    oldInput: { email: '' },
    validationErrors: []
  });
};

exports.postReset = (req, res, next) => {
  const email = req.body.email;
  const errors = validationResult(req);
  if (isProtectedAdmin(email)) {
    return res.status(422).render('auth/reset', {
      path: '/reset',
      pageTitle: 'Reset Password',
      errorMessage: 'The admin password cannot be changed from this page.',
      successMessage: null,
      oldInput: { email: email },
      validationErrors: [{ path: 'email', msg: 'The admin password cannot be changed from this page.' }]
    });
  }
  if (!errors.isEmpty()) {
    return res.status(422).render('auth/reset', {
      path: '/reset',
      pageTitle: 'Reset Password',
      errorMessage: errors.array()[0].msg,
      successMessage: null,
      oldInput: { email: email },
      validationErrors: errors.array()
    });
  }

  crypto.randomBytes(32, (err, buffer) => {
    if (err) {
      console.log(err);
      return res.redirect('/reset');
    }
    const token = buffer.toString('hex');
    let resetUser;
    User.findOne({ email: email })
      .then(user => {
        if (!user) {
          return res.status(422).render('auth/reset', {
            path: '/reset',
            pageTitle: 'Reset Password',
            errorMessage: 'No account with that email found.',
            successMessage: null,
            oldInput: { email: email },
            validationErrors: [{ path: 'email', msg: 'No account with that email found.' }]
          });
        }
        resetUser = user;
        resetUser.resetToken = hashToken(token);
        resetUser.resetTokenExpiration = Date.now() + 3600000;
        return resetUser.save();
      })
      .then(result => {
        if (!resetUser || res.headersSent) {
          return;
        }
        if (!mailUser) {
          console.log('Password reset email was not sent. MAIL_USER is missing.');
          return res.status(500).render('auth/reset', {
            path: '/reset',
            pageTitle: 'Reset Password',
            errorMessage: 'The reset email could not be sent. Try again later.',
            successMessage: null,
            oldInput: { email: email },
            validationErrors: []
          });
        }
        return sendMail({
            to: email,
            subject: 'Reset your Halo Phones password',
            html: `
            <div style="margin:0;padding:32px 12px;background:#f3ecdf;">
              <div style="max-width:520px;margin:0 auto;padding:32px 28px;background:#fffaf3;border:1px solid #d9cdb8;border-radius:18px;font-family:Arial,sans-serif;color:#17140f;">
                <p style="margin:0;font-family:Georgia,serif;font-size:28px;">Halo <span style="color:#c65a2e;">Phones</span></p>
                <h1 style="margin:22px 0 0;font-size:22px;line-height:1.3;">Reset your password</h1>
                <p style="margin:12px 0 0;font-size:15px;line-height:1.6;color:#4d463c;">We received a request to reset the password for <strong>${email}</strong>. The link below expires in one hour.</p>
                <p style="margin:24px 0 0;">
                  <a href="${appUrl}/reset/${token}" style="display:inline-block;padding:12px 22px;background:#17140f;color:#f6f1e8;text-decoration:none;border-radius:999px;font-weight:bold;">Choose a new password</a>
                </p>
                <p style="margin:22px 0 0;font-size:13px;line-height:1.5;color:#4d463c;">If you did not ask for this, ignore this email. Your password will stay the same.</p>
                <p style="margin:18px 0 0;font-size:12px;line-height:1.5;color:#4d463c;">Or copy this address into your browser:<br><a href="${appUrl}/reset/${token}" style="color:#1d4a42;">${appUrl}/reset/${token}</a></p>
              </div>
            </div>
          `
        })
          .then(() => {
            res.render('auth/reset', {
              path: '/reset',
              pageTitle: 'Reset Password',
              errorMessage: null,
              successMessage: 'The email was sent. Check your inbox for the reset link.',
              oldInput: { email: email },
              validationErrors: []
            });
          })
          .catch(err => {
            console.log(err);
            const detail = String(err && err.message || '');
            const errorMessage = /timeout|ETIMEDOUT|ECONNREFUSED/i.test(detail)
              ? 'Render’s free plan blocks Gmail. Upgrade this service to a paid instance, then send the reset again.'
              : 'The reset email could not be sent. ' + detail.replace(/\s+/g, ' ').slice(0, 240);
            return res.status(502).render('auth/reset', {
              path: '/reset',
              pageTitle: 'Reset Password',
              errorMessage: errorMessage,
              successMessage: null,
              oldInput: { email: email },
              validationErrors: []
            });
          });
      })
      .catch(err => {
        const error = new Error(err);
        error.httpStatusCode = 500;
        return next(error);
      });
  });
};

exports.getNewPassword = (req, res, next) => {
  const token = req.params.token;
  User.findOne({ resetToken: hashToken(token), resetTokenExpiration: { $gt: Date.now() } })
    .then(user => {
      if (!user || isProtectedAdmin(user.email)) {
        return res.status(403).render('auth/invalid-token', {
          path: '/reset',
          pageTitle: 'Reset link rejected',
          isAuthenticated: req.session.isLoggedIn
        });
      }
      let message = req.flash('error');
      if (message.length > 0) {
        message = message[0];
      } else {
        message = null;
      }
      res.render('auth/new-password', {
        path: '/new-password',
        pageTitle: 'New Password',
        errorMessage: message,
        userId: user._id.toString(),
        passwordToken: token,
        validationErrors: []
      });
    })
    .catch(err => {
      const error = new Error(err);
      error.httpStatusCode = 500;
      return next(error);
    });
};

exports.postNewPassword = (req, res, next) => {
  const newPassword = req.body.password;
  const userId = req.body.userId;
  const passwordToken = req.body.passwordToken;
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(422).render('auth/new-password', {
      path: '/new-password',
      pageTitle: 'New Password',
      errorMessage: errors.array()[0].msg,
      userId: userId,
      passwordToken: passwordToken,
      validationErrors: errors.array()
    });
  }

  let resetUser;

  User.findOne({
    resetToken: hashToken(passwordToken),
    resetTokenExpiration: { $gt: Date.now() },
    _id: userId
  })
    .then(user => {
      if (!user || isProtectedAdmin(user.email)) {
        return res.status(403).render('auth/invalid-token', {
          path: '/reset',
          pageTitle: 'Reset link rejected',
          isAuthenticated: req.session.isLoggedIn
        });
      }
      resetUser = user;
      return bcrypt.hash(newPassword, 12);
    })
    .then(hashedPassword => {
      if (!resetUser || res.headersSent) {
        return;
      }
      resetUser.password = hashedPassword;
      resetUser.resetToken = undefined;
      resetUser.resetTokenExpiration = undefined;
      return resetUser.save();
    })
    .then(result => {
      if (!resetUser || res.headersSent) {
        return;
      }
      res.redirect('/login');
    })
    .catch(err => {
      const error = new Error(err);
      error.httpStatusCode = 500;
      return next(error);
    });
};
