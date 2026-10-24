const { Mongoose } = require('mongoose');
const { connectDb, createDbConnector } = require('./connect');
const { EventEmitter } = require('node:events');
const uri = process.env.HOUSEKEEPING_RESOURCE_MONGO_URI;
const suite = uri ? describe : describe.skip;
const options = (mongoose, source = uri) => ({
  mongoose,
  env: {
    MONGO_URI: source,
    MONGO_MAX_POOL_SIZE: '3',
    MONGO_MIN_POOL_SIZE: '0',
    MONGO_AUTO_INDEX: 'false',
  },
  instrumentMongooseQueryMetrics: jest.fn(),
  optionalEnabled: (value) => (value === undefined ? undefined : value === 'true'),
  logger: { info: jest.fn(), error: jest.fn() },
});
suite('owned resource Mongo acquisition', () => {
  it('retains original connect/close and closes only its default connection', async () => {
    const mongoose = new Mongoose();
    const deps = options(mongoose);
    const connector = createDbConnector(deps);
    const first = connector.connect();
    expect(connector.connect()).toBe(first);
    expect(await first).toBe(mongoose);
    const other = await mongoose.createConnection(uri).asPromise();
    const close = jest.spyOn(mongoose.connection, 'close');
    try {
      expect(mongoose.connection.getClient().options.maxPoolSize).toBe(3);
      expect(deps.instrumentMongooseQueryMetrics).toHaveBeenCalledTimes(1);
      expect(() => createDbConnector(deps)).toThrow('already has an owner');
      const closing = connector.close();
      expect(connector.close()).toBe(closing);
      await closing;
      expect(close).toHaveBeenCalledTimes(1);
      expect(mongoose.connection.readyState).toBe(0);
      expect(other.readyState).toBe(1);
      await expect(connector.connect()).rejects.toThrow('closed');
    } finally {
      await connector.close();
      await other.close();
    }
  });
  it('owns an acquisition rejection before closing exactly once', async () => {
    const mongoose = new Mongoose();
    const connector = createDbConnector(
      options(mongoose, process.env.HOUSEKEEPING_RESOURCE_MONGO_FAILURE_URI),
    );
    const close = jest.spyOn(mongoose.connection, 'close');
    const opening = connector.connect();
    const observed = opening.catch((error) => error);
    const closing = connector.close();
    expect(connector.close()).toBe(closing);
    expect(await observed).toBeInstanceOf(Error);
    await closing;
    expect(close).toHaveBeenCalledTimes(1);
    expect(mongoose.connection.readyState).toBe(0);
  });
});

// A retained legacy acquisition must not construct application services or another owner.
jest.mock('@librechat/api', () => {
  throw new Error('Unexpected API import during legacy Mongo acquisition');
});

suite('legacy pending Mongo cache compatibility', () => {
  it('awaits the real pending acquisition across repeated wrapper calls without adopting ownership', async () => {
    const mongoose = require('mongoose');
    const previous = global.mongoose;
    expect(mongoose.connection.readyState).toBe(0);
    const connect = jest.spyOn(mongoose, 'connect');
    const disconnect = jest.spyOn(mongoose, 'disconnect');
    // This is the legacy wrapper's cache shape around the actual SDK acquisition.
    const original = mongoose.connect(uri, { bufferCommands: false }).then((value) => value);
    const cached = { conn: null, promise: original };
    global.mongoose = cached;
    try {
      expect(mongoose.connection.readyState).toBe(2);
      const originalClient = mongoose.connection.getClient();
      expect(() => createDbConnector(options(mongoose))).toThrow('already active');
      const reloaded = connectDb();
      const repeated = connectDb();
      expect(cached.promise).toBe(original);
      expect(cached.connector).toBeUndefined();
      expect(cached.conn).toBeNull();
      expect(connect).toHaveBeenCalledTimes(1);
      expect(await reloaded).toBe(await original);
      expect(await repeated).toBe(mongoose);
      expect(cached.conn).toBe(mongoose);
      expect(mongoose.connection.getClient()).toBe(originalClient);
      expect(await connectDb()).toBe(mongoose);
      expect(connect).toHaveBeenCalledTimes(1);
      expect(disconnect).not.toHaveBeenCalled();
      expect(cached.connector).toBeUndefined();
    } finally {
      await original.catch(() => undefined);
      await mongoose.connection.close();
      global.mongoose = previous;
    }
  });
  it('propagates the same original acquisition rejection to every waiting wrapper', async () => {
    const mongoose = require('mongoose');
    const previous = global.mongoose;
    expect(mongoose.connection.readyState).toBe(0);
    const connect = jest.spyOn(mongoose, 'connect');
    const disconnect = jest.spyOn(mongoose, 'disconnect');
    const original = mongoose
      .connect(process.env.HOUSEKEEPING_RESOURCE_MONGO_FAILURE_URI, { bufferCommands: false })
      .then((value) => value);
    const cached = { conn: null, promise: original };
    global.mongoose = cached;
    const observed = original.catch((error) => error);
    try {
      expect(mongoose.connection.readyState).toBe(2);
      const reloaded = connectDb().catch((error) => error);
      const repeated = connectDb().catch((error) => error);
      expect(cached.promise).toBe(original);
      expect(cached.connector).toBeUndefined();
      expect(connect).toHaveBeenCalledTimes(1);
      const error = await observed;
      expect(error).toBeInstanceOf(Error);
      expect(await reloaded).toBe(error);
      expect(await repeated).toBe(error);
      expect(cached.conn).toBeNull();
      expect(cached.promise).toBe(original);
      expect(cached.connector).toBeUndefined();
      expect(connect).toHaveBeenCalledTimes(1);
      expect(disconnect).not.toHaveBeenCalled();
      expect(mongoose.connection.readyState).toBe(0);
    } finally {
      await observed;
      await mongoose.connection.close();
      global.mongoose = previous;
    }
  });
});

describe('owned model bootstrap originals', () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void promise.catch(() => undefined);
    return { promise, resolve, reject };
  }
  function fixture() {
    const connection = new EventEmitter();
    connection.readyState = 0;
    connection.close = jest.fn(async () => {
      connection.readyState = 0;
    });
    const mongoose = { connection, models: {}, set: jest.fn() };
    mongoose.connect = jest.fn(async () => {
      connection.readyState = 1;
      return mongoose;
    });
    const onFailure = jest.fn();
    const connector = createDbConnector({
      ...options(mongoose, 'mongodb://fixture-only'),
      onFailure,
    });
    const model = (original) => ({ $init: original, init: jest.fn(() => original) });
    return { mongoose, connector, model, onFailure };
  }

  it('retains the actual installed Mongoose memoized init without a database connection', async () => {
    const mongoose = new Mongoose();
    const connector = createDbConnector(options(mongoose, 'mongodb://fixture-only'));
    const model = mongoose.model(
      'BootstrapIdentity',
      new mongoose.Schema(
        { value: String },
        {
          autoCreate: false,
          autoIndex: false,
        },
      ),
    );
    const original = model.$init;
    const init = jest.spyOn(model, 'init');
    connector.modelBootstrap.capture();
    await connector.modelBootstrap.join();
    expect(init).toHaveReturnedWith(original);
    expect(model.$init).toBe(original);
    expect(init).toHaveBeenCalledTimes(1);
    expect(mongoose.connection.readyState).toBe(0);
  });

  it('joins a held model original before closing the owned connection', async () => {
    const { mongoose, connector, model } = fixture();
    const original = deferred();
    mongoose.models.First = model(original.promise);
    connector.modelBootstrap.capture();
    await connector.connect();
    connector.modelBootstrap.maintenance.pauseAdmissions('held');
    const joined = connector.modelBootstrap.join();
    let settled = false;
    void joined.then(() => {
      settled = true;
    });
    const closing = connector.close();
    try {
      await tick();
      expect(settled).toBe(false);
      expect(mongoose.connection.close).not.toHaveBeenCalled();
      expect(
        (await connector.modelBootstrap.maintenance.getMaintenanceCensus('held')).complete,
      ).toBe(false);
    } finally {
      original.resolve();
    }
    await joined;
    await closing;
    expect(connector.close()).toBe(closing);
    expect(mongoose.models.First.init).toHaveBeenCalledTimes(1);
    expect(mongoose.connection.close).toHaveBeenCalledTimes(1);
  });

  it('captures partial construction and notifies the original failure before a held sibling settles', async () => {
    const { mongoose, connector, model, onFailure } = fixture();
    const original = deferred();
    const failure = new Error('partial factory');
    expect(() =>
      connector.modelBootstrap.construct(() => {
        mongoose.models.Partial = model(original.promise);
        throw failure;
      }),
    ).toThrow(failure);
    const joined = connector.modelBootstrap.join();
    const observed = joined.catch((error) => error);
    let settled = false;
    void observed.then(() => {
      settled = true;
    });
    try {
      await tick();
      expect(onFailure).toHaveBeenCalledWith(failure);
      expect(settled).toBe(false);
      expect(mongoose.connect).not.toHaveBeenCalled();
    } finally {
      original.resolve();
    }
    expect(await observed).toBe(failure);
    expect(mongoose.models.Partial.init).toHaveBeenCalledTimes(1);
  });

  it('includes later factory models and refuses model-set drift after the sealed bootstrap', async () => {
    const { mongoose, connector, model } = fixture();
    mongoose.models.First = model(Promise.resolve());
    connector.modelBootstrap.capture();
    await connector.connect();
    const late = deferred();
    mongoose.models.Upload = model(late.promise);
    connector.modelBootstrap.capture();
    connector.modelBootstrap.maintenance.pauseAdmissions('held');
    const sealed = connector.modelBootstrap.seal();
    try {
      await tick();
      expect(
        (await connector.modelBootstrap.maintenance.getMaintenanceCensus('held')).complete,
      ).toBe(false);
    } finally {
      late.resolve();
    }
    await sealed;
    expect((await connector.modelBootstrap.maintenance.getMaintenanceCensus('held')).complete).toBe(
      true,
    );
    mongoose.models.Unowned = model(Promise.resolve());
    expect((await connector.modelBootstrap.maintenance.getMaintenanceCensus('held')).complete).toBe(
      false,
    );
    expect(connector.modelBootstrap.maintenance.resumeAdmissions('held')).toBe(false);
    expect(mongoose.models.Unowned.init).not.toHaveBeenCalled();
    await expect(connector.close()).rejects.toThrow('changed');
    expect(mongoose.connection.close).not.toHaveBeenCalled();
  });

  it('observes a model rejection immediately while retaining another pending original', async () => {
    const { mongoose, connector, model, onFailure } = fixture();
    const first = deferred(),
      sibling = deferred();
    const failure = new Error('index rejected');
    mongoose.models.First = model(first.promise);
    mongoose.models.Sibling = model(sibling.promise);
    connector.modelBootstrap.capture();
    const observed = connector.modelBootstrap.join().catch((error) => error);
    let settled = false;
    void observed.then(() => {
      settled = true;
    });
    try {
      first.reject(failure);
      await tick();
      expect(onFailure).toHaveBeenCalledWith(failure);
      expect(settled).toBe(false);
    } finally {
      sibling.resolve();
    }
    expect(await observed).toBe(failure);
  });

  it('rejects a reset memoized original without restarting model initialization', async () => {
    const { mongoose, connector, model } = fixture();
    const first = model(Promise.resolve());
    mongoose.models.First = first;
    await connector.connect();
    await connector.modelBootstrap.seal();
    delete first.$init;
    expect((await connector.modelBootstrap.maintenance.getMaintenanceCensus(null)).complete).toBe(
      false,
    );
    await expect(connector.modelBootstrap.join()).rejects.toThrow('changed');
    expect(first.init).toHaveBeenCalledTimes(1);
    await expect(connector.close()).rejects.toThrow('changed');
    expect(mongoose.connection.close).not.toHaveBeenCalled();
  });

  it('retains rejected opening identity and never reconnects before its original close', async () => {
    const { mongoose, connector } = fixture();
    const failure = new Error('opening rejected');
    mongoose.connect.mockRejectedValue(failure);
    const original = connector.connect();
    await expect(original).rejects.toBe(failure);
    expect(connector.connect()).toBe(original);
    await expect(connector.modelBootstrap.seal()).rejects.toBe(failure);
    await connector.close();
    expect(mongoose.connect).toHaveBeenCalledTimes(1);
    expect(mongoose.connection.close).toHaveBeenCalledTimes(1);
  });

  it('refuses bootstrap ownership over the legacy cache without adopting or reconnecting', () => {
    const previous = global.mongoose;
    const cached = { conn: {}, promise: Promise.resolve({}) };
    global.mongoose = cached;
    try {
      expect(() => require('./connect').getDbConnector()).toThrow('legacy');
      expect(global.mongoose).toBe(cached);
      expect(cached.connector).toBeUndefined();
    } finally {
      global.mongoose = previous;
    }
  });
});
