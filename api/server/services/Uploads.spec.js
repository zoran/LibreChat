const jwt = require('jsonwebtoken');
const { Registry } = require('prom-client');
jest.mock('node:fs/promises', () => ({ mkdir: jest.fn(), lstat: jest.fn() }));
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  initializeS3: jest.fn(),
  validateEmailCodeBearer: jest.fn(),
  createRawUploadBodyHandler: jest.fn(
    jest.requireActual('@librechat/api').createRawUploadBodyHandler,
  ),
  createUploadWorkers: jest.fn(jest.requireActual('@librechat/api').createUploadWorkers),
  createUploadLiveHub: jest.fn(jest.requireActual('@librechat/api').createUploadLiveHub),
  createUploadRuntime: jest.fn(jest.requireActual('@librechat/api').createUploadRuntime),
}));
const {
  initializeS3,
  validateEmailCodeBearer,
  createRawUploadBodyHandler,
  createUploadWorkers,
  createUploadLiveHub,
  createUploadRuntime,
  UploadManagementError,
} = require('@librechat/api');
const {
  managedStorageClient,
  uploadPrincipal,
  attachmentProjection,
  initializeUploads,
  configureUploadSourceReplay,
  createUploadComposition,
} = require('./Uploads');

describe('Cortex upload adapter trust boundaries', () => {
  let previous;
  beforeEach(() => {
    previous = { ...process.env };
    process.env.JWT_SECRET = 'isolated-fixture-key';
    jest.clearAllMocks();
  });
  afterEach(() => {
    process.env = previous;
  });

  it('uses the validated durable identity, ignoring browser owner fields', async () => {
    const token = jwt.sign({ sub: 'opaque-account' }, process.env.JWT_SECRET, {
      algorithm: 'HS256',
    });
    const repository = {};
    validateEmailCodeBearer.mockResolvedValue({
      grant: { tenantId: 'tenant-a', userId: 'user-a' },
    });
    const principal = await uploadPrincipal(repository)({
      headers: { authorization: `Bearer ${token}` },
      body: { tenantId: 'tenant-b', userId: 'user-b' },
    });
    expect(principal).toEqual({
      tenantId: 'tenant-a',
      userId: 'user-a',
      authentication: 'verified-email',
    });
    expect(validateEmailCodeBearer).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'opaque-account' }),
      repository,
    );
  });

  it('rejects missing/revoked grants and unsupported token algorithms', async () => {
    const authorize = uploadPrincipal({});
    await expect(authorize({ headers: {} })).rejects.toMatchObject({ code: 'unauthorized' });
    const token = jwt.sign({ sub: 'opaque-account' }, process.env.JWT_SECRET, {
      algorithm: 'HS384',
    });
    await expect(
      authorize({ headers: { authorization: `Bearer ${token}` } }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(validateEmailCodeBearer).not.toHaveBeenCalled();
    validateEmailCodeBearer.mockResolvedValue(undefined);
    const revoked = jwt.sign({ sub: 'opaque-account' }, process.env.JWT_SECRET, {
      algorithm: 'HS256',
    });
    await expect(
      authorize({ headers: { authorization: `Bearer ${revoked}` } }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('projects only the exact principal through the live File owner and hides object locators', async () => {
    const models = {
      getFiles: jest.fn(async () => [
        {
          file_id: 'file-a',
          filename: 'document.txt',
          filepath: 'https://private-store/tenant-a/user-a/object-key',
          embedded: true,
          bytes: 10,
        },
      ]),
    };
    const result = await attachmentProjection(models)({ tenantId: 'tenant-a', userId: 'user-a' }, [
      { fileId: 'file-a' },
    ]);
    expect(models.getFiles.mock.calls[0][0]).toEqual({
      file_id: { $in: ['file-a'] },
      tenantId: 'tenant-a',
      user: 'user-a',
      retentionAcceptedAt: { $exists: true },
      embedded: true,
    });
    expect(result.get('file-a').filepath).toBe('/api/files/managed/file-a');
    expect(JSON.stringify([...result])).not.toContain('object-key');
  });

  it('leaves disabled uploads without storage initialization or filesystem work', async () => {
    process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = 'false';
    await expect(initializeUploads({})).resolves.toBeUndefined();
    expect(initializeS3).not.toHaveBeenCalled();
    expect(require('node:fs/promises').mkdir).not.toHaveBeenCalled();
  });

  it('binds source replay to the existing File quota with the exact trusted owner', async () => {
    const manager = { configureSourceReplay: jest.fn() };
    const models = {
      reserveFileSourceCopies: jest.fn(async () => ({ state: 'held' })),
      releaseFileSourceCopies: jest.fn(async () => true),
    };
    const metrics = { observeSourceReplay: jest.fn() };
    configureUploadSourceReplay({ manager, models, metrics });
    const config = manager.configureSourceReplay.mock.calls[0][0];
    const owner = { tenantId: 'tenant-a', userId: 'user-a' };
    const reservation = {
      reservationId: 'opaque-operation',
      sourceFileIds: ['file-a'],
      bytes: 29360128,
    };
    await expect(config.quota.reserveFileSourceCopies(owner, reservation)).resolves.toEqual({
      state: 'held',
    });
    await config.quota.releaseFileSourceCopies(owner, reservation);
    expect(models.reserveFileSourceCopies).toHaveBeenCalledWith(owner, reservation);
    expect(models.releaseFileSourceCopies).toHaveBeenCalledWith(owner, reservation);
    const observed = { held: 1, pendingCleanup: 1, logicalReservedBytes: 29360128 };
    config.observe(observed);
    expect(metrics.observeSourceReplay).toHaveBeenCalledWith(observed);
    expect(() => configureUploadSourceReplay({ manager, models: {}, metrics })).toThrow();
  });

  it('requires explicit purpose credentials and verified HTTPS before creating a storage client', () => {
    const valid = {
      AWS_REGION: 'us-east-1',
      AWS_BUCKET_NAME: 'managed-originals',
      AWS_ENDPOINT_URL: 'https://object-s3.example.test:8333',
      AWS_FORCE_PATH_STYLE: 'true',
      AWS_ACCESS_KEY_ID: 'fixture-access',
      AWS_SECRET_ACCESS_KEY: 'fixture-secret',
    };
    Object.assign(process.env, valid);
    initializeS3.mockReturnValue({ fixture: true });
    expect(managedStorageClient()).toEqual({ fixture: true });
    for (const [key, value] of [
      ['AWS_ACCESS_KEY_ID', ''],
      ['AWS_SECRET_ACCESS_KEY', ''],
      ['AWS_REGION', ''],
      ['AWS_BUCKET_NAME', ''],
      ['AWS_FORCE_PATH_STYLE', 'false'],
      ['AWS_ENDPOINT_URL', 'http://storage:8333'],
      ['AWS_ENDPOINT_URL', 'https://user:secret@storage:8333'],
      ['AWS_ENDPOINT_URL', 'https://storage:8333/private?secret=value'],
    ]) {
      Object.assign(process.env, valid, { [key]: value });
      initializeS3.mockClear();
      expect(() => managedStorageClient()).toThrow('Managed storage configuration unavailable');
      expect(initializeS3).not.toHaveBeenCalled();
    }
  });

  it('connects real management and transport/processing observations to the existing registry', async () => {
    process.env.EMAIL_CODE_TENANT_ID = 'tenant-a';
    const owner = { tenantId: 'tenant-a', userId: 'user-a', authentication: 'verified-email' };
    const failed = { id: 'operation', revision: 2, scope: { kind: 'personal' }, state: 'failed' };
    const repository = {
      get: jest.fn(async () => failed),
      claimController: jest.fn(async () => null),
      metrics: jest.fn(async (observedAt) => ({
        observedAt,
        admissionsPaused: true,
        states: {},
        originalBytes: 0,
        objectBytes: 0,
        textBytes: 0,
        recordBytes: 0,
        bundles: 0,
        cleanupPending: 0,
        transfers: 0,
        processors: 0,
        queue: { count: 0, bytes: 0, oldestAgeSeconds: 0 },
        quota: { usedBytes: 0, reservedBytes: 0, retainedBytes: 0 },
        staging: { count: 0, bytes: 0 },
        control: {
          mode: 'blocked',
          enabled: true,
          limits: { transferPermits: 0, processingPermits: 0, transferBytesPerSecond: 0 },
          sourceExpiresAt: observedAt,
          leaseExpiresAt: observedAt,
        },
      })),
      findReservation: jest.fn(async () => null),
      reserve: jest.fn(async () => {
        throw new UploadManagementError('quota_exceeded');
      }),
      retryProcessing: jest.fn(async () => ({
        ...failed,
        state: 'queued_processing',
        revision: 3,
      })),
    };
    const registry = new Registry();
    const platform = {
      resources: { assertSafe: async () => undefined },
      snapshots: { refresh: async () => undefined, current: () => [] },
      expected: [{ node: 'cpu-1', pool: 'originals', signal: 'cpu' }],
      hardGuards: async () => ({ safe: true, durability: 'safe' }),
    };
    const composition = await createUploadComposition({
      repository,
      models: {},
      registry,
      worker: { hostId: 'cpu-1', instanceId: 'fixture-app' },
      platform,
      storage: {},
      documents: {},
      stagingRoot: '/fixture/uploads',
      allowedOrigins: ['https://cortex.example'],
      principal: async () => owner,
    });
    try {
      expect(createUploadLiveHub).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-a' }),
      );
      const liveOptions = createUploadLiveHub.mock.calls.at(-1)[0];
      expect(liveOptions.admissionStatus()).toBeNull();
      await createUploadRuntime.mock.results.at(-1).value.tick();
      expect(liveOptions.admissionStatus()).toBe(true);
      expect(repository.metrics).toHaveBeenCalledTimes(1);
      await expect(
        composition.management.reserve(owner, {
          filename: 'tiny.txt',
          mediaType: 'text/plain',
          declaredBytes: 5,
          idempotencyKey: 'fixture',
        }),
      ).rejects.toMatchObject({ code: 'quota_exceeded' });
      await composition.management.retryProcessing(owner, failed.id);
      const transport = createRawUploadBodyHandler.mock.calls.at(-1)[0];
      transport.observe({ kind: 'accepted', bytes: 5 });
      transport.observe({ kind: 'stage', stage: 'request', seconds: 1, outcome: 'success' });
      const processing = createUploadWorkers.mock.calls.at(-1)[0].processing;
      processing.observe({ stage: 'processing', seconds: 2, outcome: 'success' });
      processing.observe({ stage: 'total', seconds: 9, outcome: 'success' });
      const text = await registry.metrics();
      expect(text).toContain('cortex_upload_admissions_paused{slot="cpu-1"} 1');
      expect(text).toContain(
        'cortex_upload_quota_rejections_total{slot="cpu-1",reason="window"} 1',
      );
      expect(text).toContain('cortex_upload_retries_total{slot="cpu-1",reason="processing"} 1');
      expect(text).toContain('cortex_upload_file_bytes_sum{slot="cpu-1"} 5');
      expect(text).toContain(
        'cortex_upload_duration_seconds_sum{slot="cpu-1",stage="request",outcome="success"} 1',
      );
      expect(text).toContain(
        'cortex_upload_duration_seconds_sum{slot="cpu-1",stage="processing",outcome="success"} 2',
      );
      expect(text).toContain(
        'cortex_upload_duration_seconds_sum{slot="cpu-1",stage="total",outcome="success"} 9',
      );
      expect(text).not.toContain('tenant-a');
      expect(text).not.toContain('user-a');
    } finally {
      await composition.close(new AbortController().signal);
    }
  });
});
