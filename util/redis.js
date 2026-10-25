const { createClient } = require('redis');

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

let client = null;
let ready = false;

function connectRedis() {
  const url = readConfig('REDIS_URL');
  if (!url) {
    console.log('Redis is off. Add REDIS_URL to use caching and shared rate limits.');
    return Promise.resolve(false);
  }
  client = createClient({
    url: url,
    socket: {
      connectTimeout: 2000,
      reconnectStrategy: false
    }
  });
  client.on('error', err => {
    ready = false;
    console.log('Redis ' + err.message);
  });
  return client
    .connect()
    .then(() => {
      ready = true;
      console.log('Redis connected');
      return true;
    })
    .catch(err => {
      ready = false;
      console.log('Redis is not available. The shop will keep using MongoDB directly. ' + err.message);
      client.removeAllListeners('error');
      return client.disconnect().catch(() => false);
    });
}

function cacheGet(key) {
  if (!ready) {
    return Promise.resolve(null);
  }
  return client
    .get(key)
    .then(raw => (raw ? JSON.parse(raw) : null))
    .catch(err => {
      console.log(err);
      return null;
    });
}

function cacheSet(key, value, seconds) {
  if (!ready) {
    return Promise.resolve();
  }
  return client.set(key, JSON.stringify(value), { EX: seconds }).catch(err => {
    console.log(err);
  });
}

function catalogKey(catalog, version) {
  return 'catalog:' + version + ':' + catalog.page + ':' + catalog.filterQuery;
}

function readCatalog(catalog) {
  if (!ready) {
    return Promise.resolve(null);
  }
  return client
    .get('catalog:version')
    .then(version => cacheGet(catalogKey(catalog, version || '0')))
    .catch(() => null);
}

function writeCatalog(catalog, payload) {
  if (!ready) {
    return Promise.resolve();
  }
  return client
    .get('catalog:version')
    .then(version => cacheSet(catalogKey(catalog, version || '0'), payload, 60))
    .catch(err => {
      console.log(err);
    });
}

function invalidateProducts(ids) {
  if (!ready) {
    return Promise.resolve();
  }
  const keys = (ids || []).filter(Boolean).map(id => 'product:' + id);
  const clear = keys.length ? client.del(keys) : Promise.resolve();
  return clear.then(() => client.incr('catalog:version')).catch(err => {
    console.log(err);
  });
}

function hitRateLimit(key, windowSeconds) {
  if (!ready) {
    return Promise.resolve(null);
  }
  return client
    .incr(key)
    .then(count => {
      if (count === 1) {
        return client.expire(key, windowSeconds).then(() => count);
      }
      return count;
    })
    .catch(err => {
      console.log(err);
      return null;
    });
}

module.exports = {
  connectRedis: connectRedis,
  cacheGet: cacheGet,
  cacheSet: cacheSet,
  readCatalog: readCatalog,
  writeCatalog: writeCatalog,
  invalidateProducts: invalidateProducts,
  hitRateLimit: hitRateLimit
};
