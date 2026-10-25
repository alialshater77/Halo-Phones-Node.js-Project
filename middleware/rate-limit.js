const { hitRateLimit } = require('../util/redis');

const buckets = new Map();

function tooMany(res, path) {
  return res.status(429).render('429', {
    pageTitle: 'Too many attempts',
    path: path
  });
}

function memoryLimit(req, max, windowMs) {
  const now = Date.now();
  const key = req.ip + ' ' + req.path;
  const recent = (buckets.get(key) || []).filter(time => now - time < windowMs);
  if (recent.length >= max) {
    return true;
  }
  recent.push(now);
  buckets.set(key, recent);
  return false;
}

module.exports = function rateLimit(max, windowMs) {
  const windowSeconds = Math.ceil(windowMs / 1000);
  return (req, res, next) => {
    hitRateLimit('rl:' + req.ip + ':' + req.path, windowSeconds)
      .then(count => {
        if (count === null) {
          if (memoryLimit(req, max, windowMs)) {
            return tooMany(res, req.path);
          }
          return next();
        }
        if (count > max) {
          return tooMany(res, req.path);
        }
        next();
      })
      .catch(err => {
        console.log(err);
        if (memoryLimit(req, max, windowMs)) {
          return tooMany(res, req.path);
        }
        next();
      });
  };
};
