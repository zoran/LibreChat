const { EventEmitter } = require('node:events');

describe('api/db/index.js bootstrap custody', () => {
  function fixture(createModels) {
    jest.resetModules();
    const connection = Object.assign(new EventEmitter(), { readyState: 0, close: jest.fn() });
    const mongoose = { connection, models: {}, set: jest.fn() };
    const onFailure = jest.fn();
    const connector = jest.requireActual('./connect').createDbConnector({
      mongoose,
      env: { MONGO_URI: 'mongodb://fixture-only' },
      optionalEnabled: () => undefined,
      instrumentMongooseQueryMetrics: jest.fn(),
      logger: { info: jest.fn(), error: jest.fn() },
      onFailure,
    });
    const order = [];
    jest.doMock('mongoose', () => mongoose);
    jest.doMock('@librechat/data-schemas', () => ({
      createModels: (value) => {
        order.push('createModels');
        return createModels(value);
      },
    }));
    jest.doMock('./connect', () => ({
      connectDb: jest.fn(),
      getDbConnector: () => {
        order.push('owner');
        return connector;
      },
    }));
    jest.doMock('./indexSync', () => {
      expect(mongoose.models.Message).toBeDefined();
      expect(mongoose.models.Conversation).toBeDefined();
      order.push('indexSync');
      return jest.fn();
    });
    return { mongoose, connector, onFailure, order };
  }
  test('retains models before indexSync while acquiring the owner before construction', async () => {
    const model = () => {
      const original = Promise.resolve();
      return { $init: original, init: jest.fn(() => original) };
    };
    const { connector, order, mongoose } = fixture((m) => {
      m.models.Message = model();
      m.models.Conversation = model();
    });
    const result = require('./index');
    expect(order).toEqual(['owner', 'createModels', 'indexSync']);
    expect(result.modelBootstrap).toBe(connector.modelBootstrap);
    await result.modelBootstrap.join();
    expect(mongoose.models.Message.init).toHaveBeenCalledTimes(1);
  });
  test('a partial factory exception keeps its model original reachable after require fails', async () => {
    let resolve;
    const original = new Promise((done) => {
      resolve = done;
    });
    const failure = new Error('partial model declaration');
    const { connector, onFailure, order } = fixture((m) => {
      m.models.Partial = { $init: original, init: jest.fn(() => original) };
      throw failure;
    });
    expect(() => require('./index')).toThrow(failure);
    expect(order).toEqual(['owner', 'createModels']);
    expect(onFailure).toHaveBeenCalledWith(failure);
    let settled = false;
    const joined = connector.modelBootstrap.join().catch((error) => {
      settled = true;
      return error;
    });
    try {
      await new Promise((done) => setImmediate(done));
      expect(settled).toBe(false);
    } finally {
      resolve();
    }
    expect(await joined).toBe(failure);
  });
});
