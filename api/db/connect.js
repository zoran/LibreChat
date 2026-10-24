/** Import is inert. The default API wrapper acquires its existing dependencies on first use. */
const owners = new WeakMap();

/** Own this default connection and newly admitted model bootstrap, never arbitrary DB work. */
function createDbConnector({
  mongoose,
  env,
  instrumentMongooseQueryMetrics,
  optionalEnabled,
  logger,
  onFailure = () => {},
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
  const modelOriginals = new Map();
  let failure;
  let drift;
  let sealed;
  let sealing;
  let pausedBy;
  function failed(error) {
    failure ??= { error };
    // Observe a rejected original immediately, before any held sibling can delay shutdown.
    try {
      onFailure(error);
    } catch {
      /* The original remains retained even if notification fails. */
    }
  }
  function changed() {
    drift ??= new Error('MongoDB model bootstrap changed after capture');
    failed(drift);
  }
  function capture() {
    const current = Object.entries(mongoose.models ?? {});
    if (
      sealed &&
      (current.length !== sealed.size ||
        current.some(([name, model]) => sealed.get(name) !== model))
    ) {
      changed();
    }
    for (const [, model] of current) {
      const retained = modelOriginals.get(model);
      if (retained) {
        if (model.$init !== retained.original) changed();
        continue;
      }
      if (sealed) {
        changed();
        continue;
      }
      let original;
      try {
        original = model.init();
      } catch (error) {
        original = Promise.reject(error);
      }
      const entry = { original, settled: false };
      modelOriginals.set(model, entry);
      if (!original || typeof original.then !== 'function') {
        entry.original = Promise.reject(
          new Error('MongoDB model initialization did not return its original promise'),
        );
      }
      if (model.$init !== entry.original) changed();
      void entry.original.then(
        () => {
          entry.settled = true;
        },
        (error) => {
          entry.settled = true;
          failed(error);
        },
      );
    }
  }
  async function settleModels() {
    // Capture late owner factories as well as partial constructors; never replace an original.
    let count;
    do {
      capture();
      count = modelOriginals.size;
      await Promise.allSettled([...modelOriginals.values()].map(({ original }) => original));
      capture();
    } while (modelOriginals.size !== count);
    if (drift) throw drift;
  }
  const modelBootstrap = Object.freeze({
    capture,
    construct(factory) {
      if (sealed || closed) throw new Error('MongoDB model bootstrap admission is closed');
      try {
        return factory();
      } catch (error) {
        failed(error);
        throw error;
      } finally {
        capture();
      }
    },
    async join() {
      await settleModels();
      if (failure) throw failure.error;
    },
    seal() {
      sealing ??= (async () => {
        await opening?.catch((error) => {
          failed(error);
        });
        await modelBootstrap.join();
        sealed = new Map(Object.entries(mongoose.models ?? {}));
        capture();
        if (failure) throw failure.error;
      })();
      return sealing;
    },
    maintenance: Object.freeze({
      pauseAdmissions(requestId) {
        if (!requestId || (pausedBy && pausedBy !== requestId)) return false;
        // The one already-admitted bootstrap stays in custody; no restart is exposed.
        pausedBy = requestId;
        return true;
      },
      resumeAdmissions(requestId) {
        capture();
        if (pausedBy !== requestId || !sealed || failure || closed) return false;
        pausedBy = undefined;
        return true;
      },
      async getMaintenanceCensus(requestId) {
        capture();
        return {
          admissionClosed: !!pausedBy && pausedBy === requestId,
          queuedContinuations: sealed ? 0 : 1,
          pendingWrites:
            Number(pending) + [...modelOriginals.values()].filter(({ settled }) => !settled).length,
          complete:
            !!sealed && !!opening && !pending && !failure && !closed && connection.readyState === 1,
        };
      },
    }),
  });
  const connector = {
    modelBootstrap,
    connect() {
      if (closed) return Promise.reject(new Error('MongoDB connector is closed'));
      if (opening) return opening;
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
        (error) => {
          pending = false;
          failed(error);
        },
      );
      return opening;
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        await opening?.catch(() => undefined);
        // A rejected but terminal model original is settled. Drift remains unknown and retains DB.
        await settleModels();
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

/** Bootstrap consumers acquire this owner before model construction; legacy cache is not adopted. */
function getDbConnector({ onFailure } = {}) {
  require('dotenv').config();
  const mongoose = require('mongoose');
  const cached = global.mongoose ?? (global.mongoose = { conn: null, promise: null });
  if (!cached.connector && (cached.conn || cached.promise))
    throw new Error('MongoDB legacy acquisition has no bootstrap owner');
  if (!cached.connector) {
    const { optionalEnabled, instrumentMongooseQueryMetrics } = require('@librechat/api');
    cached.connector = createDbConnector({
      mongoose,
      env: process.env,
      optionalEnabled,
      instrumentMongooseQueryMetrics,
      onFailure,
    });
  }
  if (!cached.connector.modelBootstrap)
    throw new Error('MongoDB legacy connector has no bootstrap owner');
  return cached.connector;
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
    cached.connector = getDbConnector();
  }
  cached.promise = cached.connector.connect();
  return cached.promise.then((connection) => {
    cached.conn = connection;
    return connection;
  });
}

module.exports = { connectDb, createDbConnector, getDbConnector };
