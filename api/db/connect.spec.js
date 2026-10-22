const { Mongoose } = require('mongoose');
const { connectDb, createDbConnector } = require('./connect');
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
