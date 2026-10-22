jest.mock('@librechat/api', () => {
  const names = [
    'performStartupChecks',
    'initializeFileStorage',
    'initializeDeploymentSkills',
    'initializeDeploymentPlugins',
    'getDeploymentPluginSkills',
    'getDeploymentPluginHookCapabilities',
    'registerDeploymentPluginHooks',
    'hasDeploymentPluginHooks',
    'hasDeploymentPluginToolApprovalHooks',
    'setPluginHookSource',
    'loadToolApprovalHooks',
    'registerShutdownTask',
    'registerBackgroundTaskShutdown',
    'updateInterfacePermissions',
    'configureAgentEventRuntime',
    'warnOnUnreachableDeliveryPaths',
    'startCodeEnvironmentLifecycleReconciler',
    'loadManagedFileDeploymentConfiguration',
  ];
  return {
    ...Object.fromEntries(names.map((name) => [name, jest.fn()])),
    getRemainingShutdownMs: jest.fn(() => 45_000),
  };
});
jest.mock('@librechat/data-schemas', () => ({
  runAsSystem: (work) => work(),
  logger: { info: jest.fn(), error: jest.fn() },
}));
jest.mock('~/db', () => ({ connectDb: jest.fn(), indexSync: jest.fn(async () => {}) }));
jest.mock('~/models', () => ({
  updateAccessPermissions: jest.fn(),
  sweepOrphanedPreviews: jest.fn(),
  getRoleByName: jest.fn(),
  seedDatabase: jest.fn(),
}));
jest.mock('../../Skills/sync', () => ({ initializeGitHubSkillSync: jest.fn() }));
jest.mock('../../Uploads', () => ({ initializeUploads: jest.fn() }));
jest.mock('../../Endpoints/agents/subagentThreadStore', () => ({
  configureSubagentTaskRouting: jest.fn(),
}));
jest.mock('../../Config', () => ({ getAppConfig: jest.fn(async () => ({})) }));
jest.mock('../../status/usage', () => ({ initializeStatusUsage: jest.fn() }));

const api = require('@librechat/api');
const models = require('~/models');
const { initializeUploads } = require('../../Uploads');
const { initializeApplicationRuntime } = require('../runtime');
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

describe('web runtime trusted configuration acquisition', () => {
  let previous;
  const source = 'a'.repeat(40);
  const options = (controller = new AbortController()) => ({
    registry: {},
    identity: { source },
    recordOriginalPublication: jest.fn(),
    projectRoot: '/fixture',
    shutdownTeardownReserveMs: 10_000,
    signal: controller.signal,
    onFailure: jest.fn(),
  });
  beforeEach(() => {
    previous = { ...process.env };
    process.env.BUILD_COMMIT = source;
    for (const suffix of ['IMAGE_DIGEST', 'NAMESPACE_UID', 'CONFIGURATION_SHA256'])
      delete process.env[`CORTEX_RETRIEVAL_EXPECTED_${suffix}`];
    jest.clearAllMocks();
    api.loadManagedFileDeploymentConfiguration.mockResolvedValue(undefined);
    initializeUploads.mockResolvedValue(undefined);
  });
  afterEach(() => {
    process.env = previous;
  });

  it('loads optional absence once before managed work and forwards the original signal', async () => {
    const input = options();
    await initializeApplicationRuntime(input);
    expect(api.loadManagedFileDeploymentConfiguration).toHaveBeenCalledTimes(1);
    expect(api.loadManagedFileDeploymentConfiguration).toHaveBeenCalledWith({
      expected: undefined,
      signal: input.signal,
      mode: 'optional',
      onFailure: input.onFailure,
    });
    expect(api.loadManagedFileDeploymentConfiguration.mock.invocationCallOrder[0]).toBeLessThan(
      models.seedDatabase.mock.invocationCallOrder[0],
    );
    expect(initializeUploads).toHaveBeenCalledWith(
      expect.objectContaining({
        trustedFile: undefined,
        signal: input.signal,
        onFailure: input.onFailure,
      }),
    );
  });

  it('captures trusted expectations and forwards the same immutable snapshot', async () => {
    Object.assign(process.env, {
      CORTEX_RETRIEVAL_EXPECTED_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
      CORTEX_RETRIEVAL_EXPECTED_NAMESPACE_UID: '11111111-1111-4111-8111-111111111111',
      CORTEX_RETRIEVAL_EXPECTED_CONFIGURATION_SHA256: 'c'.repeat(64),
    });
    const trustedFile = Object.freeze({ extractionPolicySha256: 'd'.repeat(64) });
    const input = options();
    api.loadManagedFileDeploymentConfiguration.mockImplementation(async ({ expected }) => {
      process.env.CORTEX_RETRIEVAL_EXPECTED_CONFIGURATION_SHA256 = 'e'.repeat(64);
      expect(expected.configurationSha256).toBe('c'.repeat(64));
      return trustedFile;
    });
    await initializeApplicationRuntime(input);
    expect(initializeUploads.mock.calls[0][0].trustedFile).toBe(trustedFile);
    expect(api.loadManagedFileDeploymentConfiguration.mock.calls[0][0].expected).toEqual({
      sourceRevision: source,
      imageDigest: `sha256:${'b'.repeat(64)}`,
      namespaceUid: '11111111-1111-4111-8111-111111111111',
      configurationSha256: 'c'.repeat(64),
    });
  });

  it('retains a failing configuration original before all managed work', async () => {
    const pending = deferred();
    const input = options();
    const failure = new Error('Known mounted configuration failure');
    api.loadManagedFileDeploymentConfiguration.mockImplementation(({ onFailure }) => {
      onFailure(failure);
      return pending.promise;
    });
    const original = initializeApplicationRuntime(input);
    let settled = false;
    void original.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await tick();
      expect(input.onFailure).toHaveBeenCalledWith(failure);
      expect(settled).toBe(false);
      expect(models.seedDatabase).not.toHaveBeenCalled();
      expect(initializeUploads).not.toHaveBeenCalled();
    } finally {
      pending.reject(failure);
    }
    await expect(original).rejects.toBe(failure);
  });

  it('pre-registers late upload cleanup and prevents later startup work after abort', async () => {
    const pending = deferred();
    const controller = new AbortController();
    const input = options(controller);
    const failure = new Error('Original startup aborted');
    const uploads = { close: jest.fn(async () => {}) };
    initializeUploads.mockReturnValue(pending.promise);
    const original = initializeApplicationRuntime(input);
    void original.catch(() => undefined);
    try {
      await tick();
      expect(initializeUploads).toHaveBeenCalledTimes(1);
      expect(api.registerShutdownTask).toHaveBeenCalledWith(
        'managed upload workers',
        expect.any(Function),
        { priority: 105 },
      );
      controller.abort(failure);
    } finally {
      pending.resolve(uploads);
    }
    await expect(original).rejects.toBe(failure);
    const cleanup = api.registerShutdownTask.mock.calls.find(
      ([name]) => name === 'managed upload workers',
    )[1];
    await cleanup();
    expect(uploads.close).toHaveBeenCalledTimes(1);
    expect(api.initializeDeploymentPlugins).not.toHaveBeenCalled();
  });
});
