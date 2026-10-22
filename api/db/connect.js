/** Import is inert. The default API wrapper acquires its existing dependencies on first use. */
const owners = new WeakMap();

/** Own exactly this Mongoose instance's default connection and its original acquisition. */
function createDbConnector({
  mongoose,
  env,
  instrumentMongooseQueryMetrics,
  optionalEnabled,
  logger,
}) {
  if (owners.has(mongoose)) throw new Error('MongoDB default connection already has an owner');
  const connection = mongoose.connection;
  if (!connection || connection.readyState !== 0)
    throw new Error('MongoDB default connection is already active');
  const uri = env.MONGO_URI;
  if (!uri) throw new Error('Please define the MONGO_URI environment variable');
  const opts = { bufferCommands: false };
  for (const [name, key] of [
    ['maxPoolSize', 'MONGO_MAX_POOL_SIZE'],
    ['minPoolSize', 'MONGO_MIN_POOL_SIZE'],
    ['maxConnecting', 'MONGO_MAX_CONNECTING'],
    ['maxIdleTimeMS', 'MONGO_MAX_IDLE_TIME_MS'],
    ['waitQueueTimeoutMS', 'MONGO_WAIT_QUEUE_TIMEOUT_MS'],
  ]) {
    const value = parseInt(env[key]) || undefined;
    if (value) opts[name] = value;
  }
  for (const [name, key] of [
    ['autoIndex', 'MONGO_AUTO_INDEX'],
    ['autoCreate', 'MONGO_AUTO_CREATE'],
  ]) {
    const value = optionalEnabled(env[key]);
    if (value !== undefined) opts[name] = value;
  }
  const log = logger ?? require('@librechat/data-schemas').logger;
  instrumentMongooseQueryMetrics(mongoose);
  const onError = (error) => log.error('[connectDb] MongoDB connection error:', error);
  connection.on('error', onError);
  let opening;
  let pending = false;
  let closed = false;
  let closing;
  const connector = {
    connect() {
      if (closed) return Promise.reject(new Error('MongoDB connector is closed'));
      if (opening && (pending || connection.readyState === 1)) return opening;
      pending = true;
      opening = Promise.resolve().then(() => {
        log.info('Mongo Connection options');
        log.info(JSON.stringify(opts, null, 2));
        mongoose.set('strictQuery', true);
        return mongoose.connect(uri, opts);
      });
      void opening.then(
        () => {
          pending = false;
        },
        () => {
          pending = false;
        },
      );
      return opening;
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        await opening?.catch(() => undefined);
        try {
          await connection.close();
        } finally {
          connection.off('error', onError);
        }
      })();
      return closing;
    },
  };
  owners.set(mongoose, connector);
  return connector;
}

function connectDb() {
  require('dotenv').config();
  const mongoose = require('mongoose');
  const cached = global.mongoose ?? (global.mongoose = { conn: null, promise: null });
  // Preserve a connection retained by the pre-existing default wrapper across hot reload.
  if (cached.conn && mongoose.connection.readyState === 1) return Promise.resolve(cached.conn);
  // The legacy wrapper retains its original acquisition across an in-process reload.
  if (!cached.connector && cached.promise && mongoose.connection.readyState === 2) {
    return cached.promise.then((connection) => {
      cached.conn = connection;
      return connection;
    });
  }
  if (!cached.connector) {
    const { optionalEnabled, instrumentMongooseQueryMetrics } = require('@librechat/api');
    cached.connector = createDbConnector({
      mongoose,
      env: process.env,
      optionalEnabled,
      instrumentMongooseQueryMetrics,
    });
  }
  cached.promise = cached.connector.connect();
  return cached.promise.then((connection) => {
    cached.conn = connection;
    return connection;
  });
}

module.exports = { connectDb, createDbConnector };
