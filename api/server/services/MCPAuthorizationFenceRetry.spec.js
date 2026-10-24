const mockCollection = {
  createIndex: jest.fn(),
  updateOne: jest.fn(),
  deleteOne: jest.fn(),
  find: jest.fn(),
};
const mockCollectionFor = jest.fn(() => mockCollection);
const mockRegisterShutdown = jest.fn();

jest.mock('mongoose', () => ({
  ...jest.requireActual('mongoose'),
  connection: { collection: (...args) => mockCollectionFor(...args) },
}));
jest.mock('@librechat/api', () => {
  const { createMCPAuthorizationFenceRetryService } = jest.requireActual(
    '../../../packages/api/src/mcp/authorizationRetry',
  );
  return {
    createMCPAuthorizationFenceRetryService: (deps) =>
      createMCPAuthorizationFenceRetryService({ ...deps, registerShutdown: mockRegisterShutdown }),
  };
});

function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

/** The actual adapter, retry service, storage/index helper and tenant ALS execute together. */
describe('MCPAuthorizationFenceRetry adapter', () => {
  let adapter;
  let tenantStorage;
  let toArray;
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockCollection.createIndex.mockResolvedValue('updatedAt_1');
    mockCollection.updateOne.mockResolvedValue({ acknowledged: true });
    mockCollection.deleteOne.mockResolvedValue({ deletedCount: 1 });
    toArray = jest.fn().mockResolvedValue([]);
    mockCollection.find.mockImplementation(() => ({
      sort: () => ({ limit: () => ({ toArray }) }),
    }));
    ({ tenantStorage } = require('@librechat/data-schemas'));
    adapter = require('./MCPAuthorizationFenceRetry');
  });
  afterEach(() => jest.useRealTimers());
  const stop = () =>
    mockRegisterShutdown.mock.calls.find(
      ([name]) => name === 'MCP authorization fence retry worker',
    )[1]();

  it('exposes one stable App port and constructs shutdown ownership without database dispatch', async () => {
    expect(Object.keys(adapter).sort()).toEqual([
      'clearMCPAuthorizationFenceRetry',
      'drainMCPAuthorizationFenceRetries',
      'mcpAuthorizationFenceRetryMaintenance',
      'persistMCPAuthorizationFenceRetry',
      'startMCPAuthorizationFenceRetryWorker',
    ]);
    const port = adapter.mcpAuthorizationFenceRetryMaintenance;
    expect(require('./MCPAuthorizationFenceRetry').mcpAuthorizationFenceRetryMaintenance).toBe(
      port,
    );
    expect(port.pauseAdmissions('hold')).toBe(true);
    expect(await port.getMaintenanceCensus('hold')).toEqual({
      admissionClosed: true,
      complete: true,
      pendingWrites: 0,
      queuedContinuations: 0,
    });
    expect(mockRegisterShutdown).toHaveBeenCalledTimes(2);
    expect(mockCollectionFor).not.toHaveBeenCalled();
    await stop();
  });

  it('retains original tenant, user and version through delayed publication and raw deletion', async () => {
    const scope = { userId: 'user-original', serverName: 'github' };
    const version = await tenantStorage.run(
      { tenantId: 'tenant-original', userId: scope.userId },
      () => adapter.persistMCPAuthorizationFenceRetry(scope),
    );
    toArray.mockResolvedValueOnce([
      { ...scope, tenantId: 'tenant-original', version, updatedAt: new Date() },
    ]);
    const publication = deferred();
    const deletion = deferred();
    const contexts = [];
    mockCollection.deleteOne.mockImplementationOnce(() => {
      contexts.push(tenantStorage.getStore());
      return deletion.promise;
    });
    const invalidate = jest.fn(async () => {
      contexts.push(tenantStorage.getStore());
      await publication.promise;
      contexts.push(tenantStorage.getStore());
    });
    adapter.startMCPAuthorizationFenceRetryWorker(invalidate, {
      intervalMs: 10_000,
      attemptTimeoutMs: 5,
    });
    const batch = adapter.drainMCPAuthorizationFenceRetries();
    await jest.advanceTimersByTimeAsync(5);
    await batch;
    const port = adapter.mcpAuthorizationFenceRetryMaintenance;
    expect(port.pauseAdmissions('hold')).toBe(true);
    const replacement = jest.fn();
    tenantStorage.run({ tenantId: 'tenant-next', userId: 'user-next' }, () =>
      adapter.startMCPAuthorizationFenceRetryWorker(replacement, { intervalMs: 1 }),
    );
    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    publication.resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    expect(mockCollection.deleteOne).toHaveBeenCalledWith({
      _id: JSON.stringify(['tenant-original', scope.userId, scope.serverName, version]),
      version,
    });
    expect(contexts).toEqual(Array(3).fill({ tenantId: 'tenant-original', userId: scope.userId }));
    expect(replacement).not.toHaveBeenCalled();
    deletion.resolve();
    await stopping;
    expect((await port.getMaintenanceCensus('hold')).pendingWrites).toBe(0);
  });

  it('owns public adapter writes before pause and refuses later calls without raw dispatch', async () => {
    const write = deferred();
    mockCollection.updateOne.mockReturnValueOnce(write.promise);
    const scope = { userId: 'user', serverName: 'server' };
    const original = tenantStorage.run({ tenantId: 'tenant' }, () =>
      adapter.persistMCPAuthorizationFenceRetry(scope),
    );
    const port = adapter.mcpAuthorizationFenceRetryMaintenance;
    expect(port.pauseAdmissions('hold')).toBe(true);
    expect((await port.getMaintenanceCensus('hold')).pendingWrites).toBe(1);
    await expect(adapter.persistMCPAuthorizationFenceRetry(scope)).rejects.toThrow(
      'ADMISSION_CLOSED',
    );
    await expect(adapter.clearMCPAuthorizationFenceRetry(scope, 'later')).rejects.toThrow(
      'ADMISSION_CLOSED',
    );
    expect(mockCollection.updateOne).toHaveBeenCalledTimes(1);
    expect(mockCollection.deleteOne).not.toHaveBeenCalled();
    write.resolve({ acknowledged: true });
    await original;
    await stop();
  });
});
