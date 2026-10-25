require('dotenv').config();

const path = require('path');
const fs = require('fs');
const https = require('https');

const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoDBStore = require('connect-mongodb-session')(session);
const { csrfSync } = require('csrf-sync');
const flash = require('connect-flash');
const multer = require('multer');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');

const errorController = require('./controllers/error');
const { connectRedis } = require('./util/redis');
const shopController = require('./controllers/shop');
const User = require('./models/user');

function readConfig(name) {
  if (process.env[name]) {
    return process.env[name];
  }
  try {
    return (require('./nodemon.json').env || {})[name] || '';
  } catch (err) {
    return '';
  }
}

const MONGODB_URI = `mongodb+srv://${readConfig('MONGO_USER')}:${encodeURIComponent(
  readConfig('MONGO_PASSWORD')
)}@e-commerce.gyjkjqy.mongodb.net/${readConfig('MONGO_DEFAULT_DATABASE') ||
  'shop'}?retryWrites=true&w=majority`;

const app = express();
app.set('trust proxy', 1);
const store = new MongoDBStore(
  {
    uri: MONGODB_URI,
    collection: 'sessions'
  },
  err => {
    if (err) {
      console.log(err);
    }
  }
);
const { csrfSynchronisedProtection } = csrfSync({
  getTokenFromRequest: req => {
    if (req.body && req.body._csrf) {
      return req.body._csrf;
    }
    return req.headers['csrf-token'] || req.headers['x-csrf-token'];
  }
});

// const privateKey = fs.readFileSync('server.key');
// const certificate = fs.readFileSync('server.cert');

const fileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const imagesDir = path.join(__dirname, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    cb(null, imagesDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + path.basename(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  if (
    file.mimetype === 'image/png' ||
    file.mimetype === 'image/jpg' ||
    file.mimetype === 'image/jpeg' || 
    file.mimetype === 'image/webp'
  ) {
    cb(null, true);
  } else {
    cb(null, false);
  }
};

app.set('view engine', 'ejs');
app.set('views', 'views');

const adminRoutes = require('./routes/admin');
const shopRoutes = require('./routes/shop');
const authRoutes = require('./routes/auth');

const accessLogStream = fs.createWriteStream(
  path.join(__dirname, 'access.log'),
  { flags: 'a' }
);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://js.stripe.com'],
        frameSrc: ["'self'", 'https://js.stripe.com', 'https://hooks.stripe.com'],
        connectSrc: ["'self'", 'https://api.stripe.com', 'https://m.stripe.network', 'https://q.stripe.com', 'https://r.stripe.com'],
        imgSrc: ["'self'", 'data:', 'https://stripe.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://checkout.stripe.com', 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com']
      }
    }
  })
);
app.use(compression());
app.use(morgan('combined', { stream: accessLogStream }));

const sessionSecret = readConfig('SESSION_SECRET');
const useHttps = readConfig('APP_URL').startsWith('https://');

app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: store,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: useHttps
    }
  })
);

app.use(flash());

app.use((req, res, next) => {
  res.locals.isAuthenticated = req.session.isLoggedIn;
  res.locals.isAdmin = false;
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(path.join(__dirname, 'images')));

app.use((req, res, next) => {
  if (!req.session.user) {
    return next();
  }
  User.findById(req.session.user._id)
    .then(user => {
      if (!user) {
        return next();
      }
      req.user = user;
      res.locals.isAdmin = !!user.isAdmin;
      next();
    })
    .catch(err => {
      next(new Error(err));
    });
});

app.use(bodyParser.urlencoded({ extended: false }));
app.use(
  multer({
    storage: fileStorage,
    fileFilter: fileFilter,
    limits: { fileSize: 2 * 1024 * 1024 }
  }).single('image')
);

app.use(csrfSynchronisedProtection);
app.use((req, res, next) => {
  res.locals.csrfToken = req.csrfToken();
  next();
});

app.use('/admin', adminRoutes);
app.use(shopRoutes);
app.use(authRoutes);

app.get('/500', errorController.get500);

app.use(errorController.get404);

app.use((error, req, res, next) => {
  console.log(error);
  const tooLarge = error && (error.code === 'LIMIT_FILE_SIZE' || error.message === 'File too large');
  res.status(tooLarge ? 422 : 500).render('500', {
    pageTitle: tooLarge ? 'Photo too large' : 'Error!',
    path: '/500',
    isAuthenticated: req.session ? req.session.isLoggedIn : false,
    isAdmin: req.user ? !!req.user.isAdmin : false,
    csrfToken: typeof req.csrfToken === 'function' ? req.csrfToken() : '',
    errorMessage: tooLarge ? 'Photos must be 2 MB or smaller.' : null
  });
});

mongoose
  .connect(MONGODB_URI)
  .then(result => {
    return connectRedis();
  })
  .then(() => {
    const port = process.env.PORT || 3000;
    const keyPath = path.join(__dirname, 'server.key');
    const certPath = path.join(__dirname, 'server.cert');
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      https
        .createServer(
          {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath)
          },
          app
        )
        .listen(port, () => {
          console.log('HTTPS server listening on port ' + port);
        });
      return;
    }
    app.listen(port, () => {
      console.log('Server listening on port ' + port);
    });
  })
  .catch(err => {
    console.log(err);
  });
