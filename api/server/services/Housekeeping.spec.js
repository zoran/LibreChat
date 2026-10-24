/** Composition custody tests: real shutdown/connector owners, controlled external resource originals.
 * Domain factories are contract doubles; this suite does not certify Mongo/Filer/native activation.
 */
const { EventEmitter } = require('node:events');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const configuration = () => ({
  env: {
    LOG_TO_FILE: 'false',
    BUILD_COMMIT: 'a'.repeat(40),
    MONGO_URI: 'mongodb://127.0.0.1:1/controlled-driver-only',
    AWS_BUCKET_NAME: 'fixture',
  },
  sourceId: 'a'.repeat(40),
  uploadPolicy: { securityPolicySha256: 'b'.repeat(64) },
  filePolicy: { securityPolicySha256: 'b'.repeat(64) },
  trustedFile: { retrieval: { transport: { backendIdentity: 'fixture' } } },
  allowedDomains: ['example.test'],
  timezone: 'Europe/Berlin',
  checkpointConfig: { type: 'mongo' },
});

describe('standalone Housekeeping service custody', () => {
  let api;
  let schemas;
  let shutdown;
  let mongoose;
  let redis;
  let client;
  let retrieval;
  let uploads;
  let jobs;
  let targets;
  let fileDiscovery;
  let entry;
  let retention;
  let lifecycle;
  let generationFactory;
  let mailFactory;
  let exit;
  let effects;
  let previousLog;
  let application;
  let originalWork;

  beforeEach(() => {
    jest.resetModules();
    previousLog = process.env.LOG_TO_FILE;
    process.env.LOG_TO_FILE = 'false';
    effects = [];
    const connection = new EventEmitter();
    connection.readyState = 0;
    connection.close = jest.fn(async () => effects.push('mongo.close'));
    mongoose = {
      connection,
      models: {},
      set: jest.fn(),
      connect: jest.fn(async () => mongoose),
    };
    jobs = { initialize: jest.fn(async () => {}) };
    uploads = {
      initialize: jest.fn(async () => {}),
      discoverUploadHousekeeping: jest.fn(),
      coverageUploadHousekeeping: jest.fn(),
    };
    targets = { initialize: jest.fn(async () => {}) };
    fileDiscovery = { discover: jest.fn(), coverage: jest.fn() };
    entry = {};
    retention = {};
    lifecycle = {};
    redis = { port: {}, close: jest.fn(async () => effects.push('redis.close')) };
    client = { destroy: jest.fn(() => effects.push('s3.destroy')) };
    retrieval = {
      purge: jest.fn(),
      close: jest.fn(async () => effects.push('retrieval.close')),
    };
    schemas = {
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      runAsSystem: jest.fn((work) => work()),
      createModels: jest.fn(),
      createHousekeepingStore: jest.fn(() => jobs),
      createUploadManagementRepository: jest.fn(() => uploads),
      createFileCleanupProgressMethods: jest.fn(() => targets),
      createFileRetentionMethods: jest.fn(() => retention),
      createFileCleanupClaimMethods: jest.fn(() => entry),
      createFileCleanupLifecycleMethods: jest.fn(() => lifecycle),
      createUploadFileCleanupOwner: jest.fn(() => ({})),
      createMessageMethods: jest.fn(() => ({ redactFileSourceContent: jest.fn() })),
      createFileHousekeepingDiscoveryMethods: jest.fn(() => fileDiscovery),
      createHousekeepingRepository: jest.fn(() => ({})),
      createFileNoticePort: jest.fn(() => ({})),
      createFileRetrievalOperationOwner: jest.fn(() => ({})),
    };
    jest.doMock('mongoose', () => mongoose);
    jest.doMock('@librechat/data-schemas', () => schemas);
    // Real lifecycle implementation, with only process exit replaced at the test boundary.
    shutdown = jest.requireActual('../../../packages/api/src/app/shutdown');
    exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
    originalWork = Promise.resolve();
    api = {
      ...shutdown,
      HOUSEKEEPING_POLICY: { drainMs: 120000 },
      instrumentMongooseQueryMetrics: jest.fn(),
      optionalEnabled: (value) => (value === undefined ? undefined : value === 'true'),
      createManagedS3Client: jest.fn(() => client),
      createManagedS3Storage: jest.fn(() => ({})),
      createManagedFilePurge: jest.fn(async () => retrieval),
      createManagedUploadCleanup: jest.fn(() => ({ reconcileCleanupOperation: jest.fn() })),
      createFileCleanupPort: jest.fn(() => ({})),
      purgeFileSourceCheckpoints: jest.fn(),
      createHousekeepingApplication: jest.fn((dependencies) => {
        application = {
          start: jest.fn(() => {
            shutdown.registerShutdownTask(
              'application original work',
              async () => {
                await originalWork;
                await dependencies.close();
              },
              { phase: 'pre-drain' },
            );
            return Promise.resolve();
          }),
        };
        return application;
      }),
    };
    generationFactory = jest.fn(async () => redis);
    mailFactory = jest.fn(() => undefined);
    jest.doMock('@librechat/api/housekeeping', () => api);
    jest.doMock('@librechat/api/generation-cleanup', () => ({
      createOwnedRedisGenerationCleanup: generationFactory,
    }));
    jest.doMock('@librechat/api/mail', () => ({ composeRetentionMailSender: mailFactory }));
    jest.doMock('./OutboundMail', () => ({
      readLogo: jest.fn(),
      createOutboundMailDependencies: jest.fn(),
    }));
  });

  afterEach(() => {
    shutdown.__resetShutdownStateForTests();
    exit.mockRestore();
    if (previousLog === undefined) delete process.env.LOG_TO_FILE;
    else process.env.LOG_TO_FILE = previousLog;
  });

  function service(config = configuration()) {
    return require('./Housekeeping').createHousekeepingService(config);
  }

  it('is inert before start and rejects missing/defaulted or activation-bearing configuration', () => {
    const count = process.listenerCount('SIGTERM');
    service();
    expect(mongoose.connect).not.toHaveBeenCalled();
    expect(generationFactory).not.toHaveBeenCalled();
    expect(process.listenerCount('SIGTERM')).toBe(count);
    for (const key of [
      'env',
      'sourceId',
      'uploadPolicy',
      'filePolicy',
      'trustedFile',
      'allowedDomains',
      'timezone',
      'checkpointConfig',
    ]) {
      const value = configuration();
      delete value[key];
      expect(() => service(value)).toThrow('explicit admitted configuration');
    }
    const implicitCheckpoint = configuration();
    implicitCheckpoint.checkpointConfig = {};
    expect(() => service(implicitCheckpoint)).toThrow('explicit admitted configuration');
    const activated = configuration();
    activated.uploadPolicy.reconciled = true;
    expect(() => service(activated)).toThrow('must not supply activation state');
  });

  it('composes exact current constructors, same-session discovery and actual owner adapters', async () => {
    const config = configuration();
    const value = service(config);
    const starting = value.start();
    expect(value.start()).toBe(starting);
    expect(await starting).toBe(application);
    expect(schemas.createFileCleanupClaimMethods).toHaveBeenCalledWith(mongoose, jobs, retention);
    expect(schemas.createUploadManagementRepository).toHaveBeenCalledWith(
      mongoose,
      config.uploadPolicy,
    );
    expect(schemas.createFileRetentionMethods).toHaveBeenCalledWith(mongoose, config.filePolicy);
    expect(jobs.initialize).toHaveBeenCalledTimes(1);
    expect(uploads.initialize).toHaveBeenCalledTimes(1);
    expect(targets.initialize).toHaveBeenCalledTimes(1);
    const [boundJobs, owners, policy] = schemas.createHousekeepingRepository.mock.calls[0];
    expect(boundJobs).toBe(jobs);
    expect(policy).toEqual({ sourceId: config.sourceId });
    const signal = new AbortController().signal;
    const session = { exactPinnedSnapshot: true };
    owners.discover('file.warning', 'file-cursor');
    owners.discover('upload.cleanup', 'upload-cursor');
    owners.coverage('file.cleanup', signal, session);
    owners.coverage('upload.cleanup', signal, session);
    expect(fileDiscovery.discover).toHaveBeenCalledWith('file.warning', 'file-cursor');
    expect(uploads.discoverUploadHousekeeping).toHaveBeenCalledWith('upload-cursor');
    expect(fileDiscovery.coverage).toHaveBeenCalledWith('file.cleanup', signal, session);
    expect(uploads.coverageUploadHousekeeping).toHaveBeenCalledWith(signal, session);
    const dependencies = api.createHousekeepingApplication.mock.calls[0][0];
    const cleanup = api.createManagedUploadCleanup.mock.results[0].value;
    const claim = { retained: 'claim' };
    dependencies.uploadCleanup.step(claim, signal);
    expect(cleanup.reconcileCleanupOperation).toHaveBeenCalledWith(claim, signal);
    expect(Object.keys(api.createManagedUploadCleanup.mock.calls[0][0]).sort()).toEqual([
      'repository',
      'storage',
    ]);
    const derivatives = schemas.createFileCleanupLifecycleMethods.mock.calls[0][4];
    const who = { userId: 'owner' };
    derivatives.purgeRetrieval(who, ['file'], signal);
    derivatives.purgeCheckpoints(who, ['file']);
    expect(retrieval.purge).toHaveBeenCalledWith(who, ['file'], signal);
    expect(api.purgeFileSourceCheckpoints).toHaveBeenCalledWith(
      who,
      ['file'],
      config.checkpointConfig,
    );
    const purgeOptions = api.createManagedFilePurge.mock.calls[0][0];
    const policySnapshot = { trustedPolicy: true };
    purgeOptions.operations(policySnapshot);
    expect(schemas.createFileRetrievalOperationOwner).toHaveBeenCalledWith(mongoose, {
      policySnapshot,
    });
    expect(mailFactory.mock.calls[0].slice(0, 2)).toEqual([config.env, config.allowedDomains]);
    await shutdown.requestGracefulShutdown('startup_failure');
    expect(redis.close).toHaveBeenCalledWith();
    expect(effects.at(-1)).toBe('mongo.close');
    expect(mongoose.connection.close).toHaveBeenCalledTimes(1);
  });

  it('snapshots admitted inputs and refuses a second process composition without shutting down the first', async () => {
    const config = configuration();
    const first = service(config);
    config.env.BUILD_COMMIT = 'c'.repeat(40);
    config.allowedDomains.push('changed.test');
    config.trustedFile.retrieval.transport.backendIdentity = 'changed';
    await first.start();
    expect(
      api.createManagedFilePurge.mock.calls[0][0].trustedFile.retrieval.transport.backendIdentity,
    ).toBe('fixture');
    expect(mailFactory.mock.calls[0][1]).toEqual(['example.test']);
    await expect(service().start()).rejects.toThrow('already owns this process');
    expect(shutdown.isShutdownInProgress()).toBe(false);
    expect(mongoose.connect).toHaveBeenCalledTimes(1);
    await shutdown.requestGracefulShutdown('startup_failure');
  });

  it('retains original Mongo acquisition after cancellation and admits no later resource', async () => {
    const opening = deferred();
    mongoose.connect.mockReturnValue(opening.promise);
    const previousListeners = new Set(process.listeners('SIGTERM'));
    const pending = service().start();
    const observed = pending.catch((error) => error);
    await flush();
    const ownedListeners = process
      .listeners('SIGTERM')
      .filter((listener) => !previousListeners.has(listener));
    expect(ownedListeners).toHaveLength(1);
    ownedListeners[0]('SIGTERM');
    const stopping = shutdown.requestGracefulShutdown('startup_failure');
    const budget = shutdown.getRemainingShutdownMs();
    expect(shutdown.requestGracefulShutdown('startup_failure')).toBe(stopping);
    await flush();
    expect(mongoose.connection.close).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    opening.resolve(mongoose);
    expect(await observed).toBe(shutdown.getShutdownSignal().reason);
    await stopping;
    expect(schemas.createModels).not.toHaveBeenCalled();
    expect(generationFactory).not.toHaveBeenCalled();
    expect(mongoose.connection.close).toHaveBeenCalledTimes(1);
    expect(shutdown.getRemainingShutdownMs()).toBeLessThanOrEqual(budget);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('starts the existing failure deadline immediately on rejected Mongo acquisition', async () => {
    const failure = new Error('connect failed');
    mongoose.connect.mockRejectedValue(failure);
    await expect(service().start()).rejects.toBe(failure);
    expect(shutdown.isShutdownInProgress()).toBe(true);
    await shutdown.requestGracefulShutdown('startup_failure');
    expect(mongoose.connection.close).toHaveBeenCalledTimes(1);
    expect(generationFactory).not.toHaveBeenCalled();
  });

  it('retains initialization failure and closes Mongo before any transport acquisition', async () => {
    const failure = new Error('target index failure');
    targets.initialize.mockRejectedValue(failure);
    await expect(service().start()).rejects.toBe(failure);
    await shutdown.requestGracefulShutdown('startup_failure');
    expect(generationFactory).not.toHaveBeenCalled();
    expect(mongoose.connection.close).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'])(
    'retains background model initialization through owner failure and late %s',
    async (settlement) => {
      const original = deferred();
      const failure = new Error('owner initialization failed');
      schemas.createModels.mockImplementation(() => {
        mongoose.models.Background = {
          $init: original.promise,
          init: jest.fn(() => original.promise),
        };
      });
      targets.initialize.mockRejectedValue(failure);
      let completed = false;
      const observed = service()
        .start()
        .catch((error) => {
          completed = true;
          return error;
        });
      await flush();
      expect(shutdown.isShutdownInProgress()).toBe(true);
      expect(completed).toBe(false);
      expect(mongoose.connection.close).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
      original[settlement](new Error('background index failure'));
      expect(await observed).toBe(failure);
      await shutdown.requestGracefulShutdown('startup_failure');
      expect(mongoose.models.Background.init).toHaveBeenCalledTimes(1);
      expect(mongoose.connection.close).toHaveBeenCalledTimes(1);
    },
  );

  it('waits for original background initialization before transferring resources to the application', async () => {
    const original = deferred();
    schemas.createModels.mockImplementation(() => {
      mongoose.models.Background = {
        $init: original.promise,
        init: jest.fn(() => original.promise),
      };
    });
    const pending = service().start();
    await flush();
    expect(api.createHousekeepingApplication).not.toHaveBeenCalled();
    original.resolve();
    await pending;
    expect(application.start).toHaveBeenCalledTimes(1);
    await shutdown.requestGracefulShutdown('startup_failure');
  });

  it('captures a partial model factory and joins the original before failed acquisition can close', async () => {
    const original = deferred();
    const failure = new Error('partial schema factory');
    schemas.createModels.mockImplementation(() => {
      mongoose.models.Partial = { $init: original.promise, init: jest.fn(() => original.promise) };
      throw failure;
    });
    const observed = service()
      .start()
      .catch((error) => error);
    try {
      await flush();
      expect(shutdown.isShutdownInProgress()).toBe(true);
      expect(mongoose.connection.close).not.toHaveBeenCalled();
      expect(generationFactory).not.toHaveBeenCalled();
    } finally {
      original.resolve();
    }
    expect(await observed).toBe(failure);
    await shutdown.requestGracefulShutdown('startup_failure');
    expect(mongoose.connection.close).toHaveBeenCalledTimes(1);
  });

  it('retains a model created by the later Retrieval factory before transferring custody', async () => {
    const original = deferred();
    schemas.createFileRetrievalOperationOwner.mockImplementation(() => {
      mongoose.models.Retrieval = {
        $init: original.promise,
        init: jest.fn(() => original.promise),
      };
      return {};
    });
    api.createManagedFilePurge.mockImplementation(async ({ operations }) => {
      operations({});
      return retrieval;
    });
    const starting = service().start();
    try {
      await flush();
      expect(api.createHousekeepingApplication).not.toHaveBeenCalled();
      expect(mongoose.models.Retrieval.init).toHaveBeenCalledTimes(1);
    } finally {
      original.resolve();
    }
    await starting;
    await shutdown.requestGracefulShutdown('startup_failure');
    expect(mongoose.connection.close).toHaveBeenCalledTimes(1);
  });

  it('owns a Redis handle returned after cancellation and closes it without starting S3', async () => {
    const opening = deferred();
    generationFactory.mockReturnValue(opening.promise);
    const observed = service()
      .start()
      .catch((error) => error);
    await flush();
    const stopping = shutdown.requestGracefulShutdown('startup_failure');
    expect(redis.close).not.toHaveBeenCalled();
    opening.resolve(redis);
    expect(await observed).toBe(shutdown.getShutdownSignal().reason);
    await stopping;
    expect(redis.close).toHaveBeenCalledTimes(1);
    expect(api.createManagedS3Client).not.toHaveBeenCalled();
    expect(effects).toEqual(['redis.close', 'mongo.close']);
  });

  it('settles acquired Redis and S3 when the original Retrieval acquisition rejects', async () => {
    const failure = new Error('retrieval configuration rejected');
    api.createManagedFilePurge.mockRejectedValue(failure);
    await expect(service().start()).rejects.toBe(failure);
    await shutdown.requestGracefulShutdown('startup_failure');
    expect(redis.close).toHaveBeenCalledTimes(1);
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(retrieval.close).not.toHaveBeenCalled();
    expect(api.createHousekeepingApplication).not.toHaveBeenCalled();
    expect(effects.at(-1)).toBe('mongo.close');
  });

  it.each(['constructor', 'synchronous start'])(
    'closes untransferred resources on application %s failure',
    async (kind) => {
      const failure = new Error(kind);
      api.createHousekeepingApplication.mockImplementation(() => {
        if (kind === 'constructor') throw failure;
        return {
          start: () => {
            throw failure;
          },
        };
      });
      await expect(service().start()).rejects.toBe(failure);
      await shutdown.requestGracefulShutdown('startup_failure');
      expect(retrieval.close).toHaveBeenCalledTimes(1);
      expect(redis.close).toHaveBeenCalledTimes(1);
      expect(client.destroy).toHaveBeenCalledTimes(1);
      expect(mongoose.connection.close).toHaveBeenCalledTimes(1);
    },
  );

  it('leaves transferred resources with application original work until that work settles', async () => {
    const work = deferred();
    originalWork = work.promise;
    await service().start();
    const stopping = shutdown.requestGracefulShutdown('startup_failure');
    await flush();
    expect(effects).toEqual([]);
    work.resolve();
    await stopping;
    expect(retrieval.close).toHaveBeenCalledTimes(1);
    expect(mongoose.connection.close).toHaveBeenCalledTimes(1);
  });

  it('preserves unresolved close custody and Mongo while settling independent transports', async () => {
    retrieval.close.mockRejectedValue(new Error('retained retrieval work'));
    await service().start();
    const stopping = shutdown.requestGracefulShutdown('startup_failure');
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    const budget = shutdown.getRemainingShutdownMs();
    await flush();
    expect(redis.close).toHaveBeenCalledTimes(1);
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(mongoose.connection.close).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    expect(exit).not.toHaveBeenCalled();
    expect(shutdown.requestGracefulShutdown('startup_failure')).toBe(stopping);
    expect(shutdown.getRemainingShutdownMs()).toBeLessThanOrEqual(budget);
  });
});
