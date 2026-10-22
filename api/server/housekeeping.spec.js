/** Real configuration/schema/shutdown and service acquisition; external resource originals are controlled.
 * These tests do not certify native delivery, backend coverage or activation.
 */
const { EventEmitter } = require('node:events');
const realFs = jest.requireActual('node:fs/promises');
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
const required = [
  'BUILD_COMMIT',
  'CORTEX_RETRIEVAL_EXPECTED_IMAGE_DIGEST',
  'CORTEX_RETRIEVAL_EXPECTED_NAMESPACE_UID',
  'CORTEX_RETRIEVAL_EXPECTED_CONFIGURATION_SHA256',
  'UPLOAD_SECURITY_POLICY_SHA256',
  'EMAIL_CODE_ALLOWED_DOMAINS',
  'RETENTION_MAIL_TIMEZONE',
];
const environment = () => ({
  LOG_TO_FILE: 'false',
  BUILD_COMMIT: 'a'.repeat(40),
  CORTEX_RETRIEVAL_EXPECTED_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
  CORTEX_RETRIEVAL_EXPECTED_NAMESPACE_UID: '11111111-1111-4111-8111-111111111111',
  CORTEX_RETRIEVAL_EXPECTED_CONFIGURATION_SHA256: 'c'.repeat(64),
  UPLOAD_SECURITY_POLICY_SHA256: 'd'.repeat(64),
  EMAIL_CODE_ALLOWED_DOMAINS: ' Employees.Example.Test, partners.example.test ',
  RETENTION_MAIL_TIMEZONE: 'Europe/Berlin',
  MONGO_URI: 'mongodb://127.0.0.1:1/controlled-driver-only',
});

describe('standalone Housekeeping executable configuration and custody', () => {
  let shutdown;
  let api;
  let open;
  let handle;
  let trustedFile;
  let createService;
  let startService;
  let exit;
  let previousLog;
  let logger;

  function mounted(text = 'version: 1.3.1\n') {
    const bytes = Buffer.from(text);
    return {
      stat: jest.fn(async () => ({ isFile: () => true, size: bytes.length })),
      read: jest.fn(async (buffer, offset, length, position) => ({
        bytesRead: bytes.copy(buffer, offset, position, position + length),
      })),
      close: jest.fn(async () => {}),
    };
  }

  beforeEach(() => {
    jest.resetModules();
    previousLog = process.env.LOG_TO_FILE;
    process.env.LOG_TO_FILE = 'false';
    logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    jest.doMock('@librechat/data-schemas', () => ({ logger }));
    jest.doMock('module-alias', () => jest.fn());
    shutdown = jest.requireActual('../../packages/api/src/app/shutdown');
    const { resolveCheckpointerConfig } = jest.requireActual(
      '../../packages/api/src/agents/checkpoints/config',
    );
    exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
    handle = mounted();
    open = jest.fn(async () => handle);
    jest.doMock('node:fs/promises', () => ({ open }));
    trustedFile = {
      extractionPolicySha256: 'e'.repeat(64),
      retrievalInventoryAuthority: { binding: 'controlled-loader-result' },
    };
    api = {
      ...shutdown,
      HOUSEKEEPING_POLICY: { drainMs: 120000 },
      resolveCheckpointerConfig,
      loadManagedFileDeploymentConfiguration: jest.fn(async () => trustedFile),
    };
    jest.doMock('@librechat/api/housekeeping', () => api);
    startService = jest.fn(async () => ({ ready: true }));
    createService = jest.fn(() => ({ start: startService }));
    jest.doMock('./services/Housekeeping', () => ({ createHousekeepingService: createService }));
  });

  afterEach(async () => {
    if (shutdown.isShutdownInProgress()) await shutdown.requestGracefulShutdown('startup_failure');
    shutdown.__resetShutdownStateForTests();
    exit.mockRestore();
    if (previousLog === undefined) delete process.env.LOG_TO_FILE;
    else process.env.LOG_TO_FILE = previousLog;
  });

  const entry = () => require('./housekeeping');

  it('is inert at import, snapshots supplied identities and invokes one service with actual defaults', async () => {
    const count = process.listenerCount('SIGTERM');
    const { startHousekeeping } = entry();
    expect(process.listenerCount('SIGTERM')).toBe(count);
    expect(open).not.toHaveBeenCalled();
    expect(api.loadManagedFileDeploymentConfiguration).not.toHaveBeenCalled();
    const env = environment();
    const original = startHousekeeping(env);
    env.BUILD_COMMIT = 'f'.repeat(40);
    expect(startHousekeeping(environment())).toBe(original);
    await expect(original).resolves.toEqual({ ready: true });
    expect(api.loadManagedFileDeploymentConfiguration).toHaveBeenCalledWith({
      expected: {
        sourceRevision: 'a'.repeat(40),
        imageDigest: `sha256:${'b'.repeat(64)}`,
        namespaceUid: environment().CORTEX_RETRIEVAL_EXPECTED_NAMESPACE_UID,
        configurationSha256: 'c'.repeat(64),
      },
      signal: shutdown.getShutdownSignal(),
      mode: 'required',
      onFailure: expect.any(Function),
    });
    const config = createService.mock.calls[0][0];
    expect(config).toMatchObject({
      sourceId: 'a'.repeat(40),
      trustedFile,
      timezone: 'Europe/Berlin',
      allowedDomains: ['employees.example.test', 'partners.example.test'],
      filePolicy: { securityPolicySha256: 'd'.repeat(64), extractionPolicySha256: 'e'.repeat(64) },
      uploadPolicy: {
        securityPolicySha256: 'd'.repeat(64),
        extractionPolicySha256: 'e'.repeat(64),
        retrievalInventoryAuthority: trustedFile.retrievalInventoryAuthority,
      },
      checkpointConfig: {
        type: 'mongo',
        ttl: 86400,
        checkpointCollectionName: 'agent_checkpoints',
        checkpointWritesCollectionName: 'agent_checkpoint_writes',
      },
    });
    expect(Object.keys(config.uploadPolicy).sort()).toEqual([
      'extractionPolicySha256',
      'retrievalInventoryAuthority',
      'securityPolicySha256',
    ]);
    const { constants } = require('node:fs');
    expect(open).toHaveBeenCalledWith(
      '/app/librechat.yaml',
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(startService).toHaveBeenCalledTimes(1);
  });

  it.each(required)(
    'refuses missing %s before acquiring either configuration file',
    async (key) => {
      const env = environment();
      delete env[key];
      await expect(entry().startHousekeeping(env)).rejects.toThrow('configuration unavailable');
      await shutdown.requestGracefulShutdown('startup_failure');
      expect(open).not.toHaveBeenCalled();
      expect(api.loadManagedFileDeploymentConfiguration).not.toHaveBeenCalled();
      expect(createService).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(1);
    },
  );

  it.each([
    ['RETENTION_MAIL_TIMEZONE', 'invalid/no-zone'],
    ['CONFIG_PATH', 'https://config.example.test/librechat.yaml'],
    ['UPLOAD_SECURITY_POLICY_SHA256', 'not-an-admitted-digest'],
    ['EMAIL_CODE_ALLOWED_DOMAINS', '*'],
  ])('refuses invalid %s without a fallback', async (key, value) => {
    await expect(entry().startHousekeeping({ ...environment(), [key]: value })).rejects.toThrow(
      'configuration unavailable',
    );
    expect(open).not.toHaveBeenCalled();
    expect(api.loadManagedFileDeploymentConfiguration).not.toHaveBeenCalled();
  });

  it('requires import-time file logging to be disabled', async () => {
    process.env.LOG_TO_FILE = 'true';
    await expect(entry().startHousekeeping(environment())).rejects.toThrow(
      'configuration unavailable',
    );
    expect(shutdown.isShutdownInProgress()).toBe(false);
    expect(api.loadManagedFileDeploymentConfiguration).not.toHaveBeenCalled();
  });

  it('reads an actual local YAML handle and preserves explicit checkpoint settings', async () => {
    const path = require('node:path');
    const directory = await realFs.mkdtemp(path.join(process.env.TMPDIR, 'housekeeping-cli-'));
    let actual;
    try {
      const file = path.join(directory, 'config.yaml');
      await realFs.writeFile(
        file,
        'endpoints:\n  agents:\n    checkpointer:\n      type: memory\n      ttl: 17\n      checkpointCollectionName: retained\n      checkpointWritesCollectionName: retained_writes\n',
      );
      open.mockImplementation(async () => {
        actual = await realFs.open(file, 'r');
        return actual;
      });
      await entry().startHousekeeping(environment());
      expect(createService.mock.calls[0][0].checkpointConfig).toEqual({
        type: 'memory',
        ttl: 17,
        checkpointCollectionName: 'retained',
        checkpointWritesCollectionName: 'retained_writes',
      });
      expect(actual.fd).toBe(-1);
    } finally {
      await actual?.close();
      await realFs.rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    'endpoints: []\n',
    'endpoints:\n  agents:\n    checkpointer: { type: memory, unexpected: true }\n',
    'endpoints:\n  agents:\n    checkpointer: { ttl: 0 }\n',
  ])('fails closed for malformed checkpoint configuration: %s', async (text) => {
    handle = mounted(text);
    await expect(entry().startHousekeeping(environment())).rejects.toThrow(
      'configuration unavailable',
    );
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(createService).not.toHaveBeenCalled();
  });

  it('retains the required Retrieval original across shutdown and prevents service acquisition', async () => {
    const loading = deferred();
    api.loadManagedFileDeploymentConfiguration.mockReturnValue(loading.promise);
    const startup = entry().startHousekeeping(environment());
    const outcome = startup.catch((error) => error);
    await flush();
    const originalShutdown = shutdown.requestGracefulShutdown('startup_failure');
    await flush();
    expect(exit).not.toHaveBeenCalled();
    loading.resolve(trustedFile);
    expect(await outcome).toBe(shutdown.getShutdownSignal().reason);
    await originalShutdown;
    expect(open).not.toHaveBeenCalled();
    expect(createService).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('starts the original deadline on loader failure while its original close remains pending', async () => {
    const closing = deferred();
    const failure = new Error('controlled read failure');
    api.loadManagedFileDeploymentConfiguration.mockImplementation(async ({ onFailure }) => {
      onFailure(failure);
      await closing.promise;
      throw failure;
    });
    const outcome = entry()
      .startHousekeeping(environment())
      .catch((error) => error);
    await flush();
    const remaining = shutdown.getRemainingShutdownMs();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(120000);
    const originalShutdown = shutdown.requestGracefulShutdown('startup_failure');
    expect(shutdown.requestGracefulShutdown('startup_failure')).toBe(originalShutdown);
    expect(exit).not.toHaveBeenCalled();
    closing.resolve();
    expect(await outcome).toBe(failure);
    await originalShutdown;
    expect(createService).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('joins a late checkpoint open and its original close after abort', async () => {
    const opening = deferred();
    const closing = deferred();
    open.mockReturnValue(opening.promise);
    handle.close.mockReturnValue(closing.promise);
    const outcome = entry()
      .startHousekeeping(environment())
      .catch((error) => error);
    await flush();
    const originalShutdown = shutdown.requestGracefulShutdown('startup_failure');
    opening.resolve(handle);
    await flush();
    expect(handle.read).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    closing.resolve();
    expect(await outcome).toBe(shutdown.getShutdownSignal().reason);
    await originalShutdown;
    expect(createService).not.toHaveBeenCalled();
  });

  it('announces checkpoint failure before joining original close', async () => {
    handle = mounted('endpoints: []\n');
    const closing = deferred();
    handle.close.mockReturnValue(closing.promise);
    const outcome = entry()
      .startHousekeeping(environment())
      .catch((error) => error);
    await flush();
    expect(shutdown.isShutdownInProgress()).toBe(true);
    expect(shutdown.getRemainingShutdownMs()).toBeGreaterThan(0);
    expect(exit).not.toHaveBeenCalled();
    closing.resolve();
    expect(await outcome).toEqual(new Error('Housekeeping configuration unavailable'));
    await shutdown.requestGracefulShutdown('startup_failure');
    expect(createService).not.toHaveBeenCalled();
  });

  it('transfers to the actual service and connector without cycling their original acquisition', async () => {
    const connecting = deferred();
    const closing = deferred();
    const connection = new EventEmitter();
    connection.readyState = 0;
    connection.close = jest.fn(() => closing.promise);
    const mongoose = {
      connection,
      models: {},
      set: jest.fn(),
      connect: jest.fn(() => connecting.promise),
    };
    jest.doMock('mongoose', () => mongoose);
    jest.doMock('@librechat/api/generation-cleanup', () => ({
      createOwnedRedisGenerationCleanup: jest.fn(),
    }));
    jest.doMock('@librechat/api/mail', () => ({ composeRetentionMailSender: jest.fn() }));
    jest.doMock('./services/OutboundMail', () => ({
      readLogo: jest.fn(),
      createOutboundMailDependencies: jest.fn(),
    }));
    api.instrumentMongooseQueryMetrics = jest.fn();
    api.optionalEnabled = () => undefined;
    createService.mockImplementation(
      jest.requireActual('./services/Housekeeping').createHousekeepingService,
    );
    const outcome = entry()
      .startHousekeeping(environment())
      .catch((error) => error);
    await flush();
    expect(mongoose.connect).toHaveBeenCalledTimes(1);
    const originalShutdown = shutdown.requestGracefulShutdown('startup_failure');
    await flush();
    expect(connection.close).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    connecting.resolve(mongoose);
    await flush();
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    closing.resolve();
    expect(await outcome).toBe(shutdown.getShutdownSignal().reason);
    await originalShutdown;
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
