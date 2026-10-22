const jwt = require('jsonwebtoken');
const { Registry } = require('prom-client');
jest.mock('node:fs/promises', () => ({ mkdir: jest.fn(), lstat: jest.fn(), readFile: jest.fn() }));
jest.mock('~/models', () => ({}));
jest.mock('./UploadPlatform', () => ({ createUploadPlatform: jest.fn() }));
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  createUploadManagementRepository: jest.fn(),
}));
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  initializeS3: jest.fn(),
  createHttpUploadSecurityPort: jest.fn(),
  validateEmailCodeBearer: jest.fn(),
  createRawUploadBodyHandler: jest.fn(),
  createIntakeControlHandlers: jest.fn(
    jest.requireActual('@librechat/api').createIntakeControlHandlers,
  ),
  createUploadWorkers: jest.fn(jest.requireActual('@librechat/api').createUploadWorkers),
  createUploadLiveHub: jest.fn(jest.requireActual('@librechat/api').createUploadLiveHub),
  createUploadRuntime: jest.fn(jest.requireActual('@librechat/api').createUploadRuntime),
  createManagedFileRetrieval: jest.fn(
    jest.requireActual('@librechat/api').createManagedFileRetrieval,
  ),
}));
const {
  initializeS3,
  validateEmailCodeBearer,
  createRawUploadBodyHandler,
  createUploadWorkers,
  createIntakeControlHandlers,
  createUploadLiveHub,
  createUploadRuntime,
  createManagedFileRetrieval,
  createHttpUploadSecurityPort,
  UploadManagementError,
} = require('@librechat/api');
const {
  managedStorageClient,
  managedSecurityClient,
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

  it('requires operator-owned scanner identity and policy before enabling uploads', async () => {
    delete process.env.UPLOAD_SECURITY_ENDPOINT;
    await expect(managedSecurityClient()).rejects.toThrow(
      'Upload security configuration unavailable',
    );
    const { readFile } = require('node:fs/promises');
    expect(readFile).not.toHaveBeenCalled();
    expect(createHttpUploadSecurityPort).not.toHaveBeenCalled();
  });

  it('binds the fixed scanner endpoint to mounted mTLS credentials', async () => {
    process.env.UPLOAD_SECURITY_ENDPOINT = 'https://intake.internal:8443';
    process.env.UPLOAD_SECURITY_ALLOWED_HOSTS = 'intake.internal';
    process.env.UPLOAD_SECURITY_POLICY_SHA256 = 'a'.repeat(64);
    for (const name of ['CA', 'CERT', 'KEY'])
      process.env[`UPLOAD_SECURITY_TLS_${name}_FILE`] = `/run/intake/${name.toLowerCase()}.pem`;
    const { readFile } = require('node:fs/promises');
    readFile.mockResolvedValue(Buffer.from('isolated-test-material'));
    await managedSecurityClient();
    expect(createHttpUploadSecurityPort).toHaveBeenCalledWith({
      endpoint: 'https://intake.internal:8443',
      allowedHosts: ['intake.internal'],
      policySha256: 'a'.repeat(64),
      tls: {
        ca: Buffer.from('isolated-test-material'),
        cert: Buffer.from('isolated-test-material'),
        key: Buffer.from('isolated-test-material'),
      },
    });
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

  it('uses actual browser-cookie bearer validation and never merges guest/email accounts', async () => {
    const { BROWSER_COOKIE, setAuthSelection } = jest.requireActual('@librechat/api');
    process.env.AUTH_MODE = 'transition';
    process.env.CORTEX_UPLOAD_GUEST_TRANSITION_ENABLED = 'true';
    const id = 'a'.repeat(24),
      credential = `${id}.${'b'.repeat(43)}`;
    const user = { id, _id: id, provider: 'browser', role: 'USER', emailVerified: false };
    const repository = {
      findBrowserIdentity: jest.fn(async () => ({
        user,
        sessionId: 'c'.repeat(24),
        expiration: new Date(Date.now() + 60000),
      })),
    };
    const token = jwt.sign({ id, provider: 'browser' }, process.env.JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: 60,
    });
    const request = {
      headers: { authorization: `Bearer ${token}`, cookie: `${BROWSER_COOKIE}=${credential}` },
      cookies: { [BROWSER_COOKIE]: credential },
    };
    const authorize = uploadPrincipal(repository);
    expect(await authorize(request)).toEqual({
      authentication: 'guest',
      tenantId: null,
      userId: id,
    });
    expect(validateEmailCodeBearer).not.toHaveBeenCalled();
    const mixed = {
      ...request,
      cookies: { [BROWSER_COOKIE]: `${'d'.repeat(24)}.${'b'.repeat(43)}` },
    };
    await expect(authorize(mixed)).rejects.toMatchObject({ code: 'unauthorized' });
    setAuthSelection(
      {
        cookie: (name, value) => {
          request.cookies[name] = value;
        },
      },
      'email',
    );
    await expect(authorize(request)).rejects.toMatchObject({ code: 'unauthorized' });
    delete request.cookies['__Host-librechat-auth-selection'];
    repository.findBrowserIdentity.mockResolvedValue(null);
    await expect(authorize(request)).rejects.toMatchObject({ code: 'unauthorized' });
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

  it.each([
    undefined,
    { podUid: 'other-pod', source: 'a'.repeat(40), incarnation: 'c'.repeat(36) },
    {
      podUid: '12345678-1234-4234-8234-123456789012',
      source: 'b'.repeat(40),
      incarnation: '52345678-1234-4234-8234-123456789012',
    },
  ])(
    'requires the actual application process identity before opening upload dependencies',
    async (identity) => {
      process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = 'true';
      process.env.POD_UID = '12345678-1234-4234-8234-123456789012';
      process.env.BUILD_COMMIT = 'a'.repeat(40);
      await expect(initializeUploads({ identity })).rejects.toThrow(
        'Upload process identity unavailable',
      );
      expect(initializeS3).not.toHaveBeenCalled();
      expect(require('node:fs/promises').readFile).not.toHaveBeenCalled();
      expect(require('node:fs/promises').mkdir).not.toHaveBeenCalled();
    },
  );

  it('binds native policy without forwarding per-File inventory from web startup configuration', async () => {
    Object.assign(process.env, {
      CORTEX_UPLOAD_MANAGEMENT_ENABLED: 'true',
      POD_NODE_NAME: 'cpu-2',
      POD_UID: '12345678-1234-4234-8234-123456789012',
      BUILD_COMMIT: 'a'.repeat(40),
      UPLOAD_SECURITY_ENDPOINT: 'https://scanner.example.test:8443',
      UPLOAD_SECURITY_ALLOWED_HOSTS: 'scanner.example.test',
      UPLOAD_SECURITY_POLICY_SHA256: 'a'.repeat(64),
      AWS_REGION: 'us-east-1',
      AWS_BUCKET_NAME: 'fixture-originals',
      AWS_ENDPOINT_URL: 'https://storage.example.test:8333',
      AWS_FORCE_PATH_STYLE: 'true',
      AWS_ACCESS_KEY_ID: 'fixture-access',
      AWS_SECRET_ACCESS_KEY: 'fixture-secret',
    });
    for (const prefix of ['UPLOAD_SECURITY_TLS', 'UPLOAD_INTAKE'])
      for (const name of ['CA', 'CERT', 'KEY', ...(prefix === 'UPLOAD_INTAKE' ? ['PEERS'] : [])])
        process.env[`${prefix}_${name}_FILE`] = `/fixture/${prefix}-${name}`;
    const { readFile, lstat } = require('node:fs/promises');
    readFile.mockImplementation(async (file) =>
      Buffer.from(file.endsWith('PEERS') ? '[]' : 'fixture-tls'),
    );
    lstat.mockResolvedValue({
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: process.getuid(),
      mode: 0o700,
    });
    initializeS3.mockReturnValue({ fixture: true });
    const security = { policySha256: 'b'.repeat(64) };
    createHttpUploadSecurityPort.mockReturnValue(security);
    const { createUploadManagementRepository } = require('@librechat/data-schemas');
    const repository = { initialize: jest.fn(async () => {}) };
    createUploadManagementRepository.mockReturnValue(repository);
    const { createUploadPlatform } = require('./UploadPlatform');
    createUploadPlatform.mockRejectedValue(new Error('fixture-platform-stop'));
    const identity = Object.freeze({
      podUid: process.env.POD_UID,
      source: process.env.BUILD_COMMIT,
      incarnation: '52345678-1234-4234-8234-123456789012',
    });
    const recordOriginalPublication = jest.fn();
    const trustedFile = {
      extractionPolicySha256: 'c'.repeat(64),
      retrievalInventoryAuthority: { perFile: true },
    };
    await expect(
      initializeUploads({ identity, trustedFile, recordOriginalPublication }),
    ).rejects.toThrow('fixture-platform-stop');
    expect(createUploadManagementRepository).toHaveBeenCalledWith(require('mongoose'), {
      securityPolicySha256: security.policySha256,
      extractionPolicySha256: trustedFile.extractionPolicySha256,
      recordOriginalPublication,
    });
    expect(createUploadManagementRepository.mock.calls[0][1]).not.toHaveProperty(
      'retrievalInventoryAuthority',
    );
    expect(createUploadPlatform).toHaveBeenCalledWith({
      repository,
      worker: { hostId: 'cpu-2', instanceId: identity.incarnation },
      stagingRoot: '/var/lib/cortex/uploads/staging',
    });
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
    const createClient = jest
      .spyOn(require('@aws-sdk/client-s3'), 'S3Client')
      .mockImplementation(() => ({ fixture: true }));
    try {
      expect(managedStorageClient()).toEqual({ fixture: true });
      expect(createClient).toHaveBeenCalledWith({
        region: valid.AWS_REGION,
        endpoint: 'https://object-s3.example.test:8333/',
        forcePathStyle: true,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        credentials: {
          accessKeyId: valid.AWS_ACCESS_KEY_ID,
          secretAccessKey: valid.AWS_SECRET_ACCESS_KEY,
        },
      });
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
        createClient.mockClear();
        expect(() => managedStorageClient()).toThrow('Managed storage configuration unavailable');
        expect(createClient).not.toHaveBeenCalled();
      }
    } finally {
      createClient.mockRestore();
    }
  });

  it('connects App promotion and processing with the original web startup signal', async () => {
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
    const startupController = new AbortController();
    const signal = startupController.signal;
    const composition = await createUploadComposition({
      repository,
      models: {},
      registry,
      worker: { hostId: 'cpu-1', instanceId: 'fixture-app' },
      platform,
      storage: {},
      documents: {},
      security: { prepare: jest.fn(), inspect: jest.fn(), cancel: jest.fn() },
      stagingRoot: '/fixture/uploads',
      allowedOrigins: ['https://cortex.example'],
      principal: async () => owner,
      signal,
    });
    try {
      expect(createManagedFileRetrieval).toHaveBeenCalledWith(expect.objectContaining({ signal }));
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
          mediaType: 'text/plain',
          declaredBytes: 5,
          idempotencyKey: '00000000-0000-4000-8000-000000000001',
        }),
      ).rejects.toMatchObject({ code: 'quota_exceeded' });
      await composition.management.retryProcessing(owner, failed.id);
      expect(createRawUploadBodyHandler).not.toHaveBeenCalled();
      expect(createIntakeControlHandlers).toHaveBeenCalledWith(
        expect.objectContaining({
          repository,
          management: composition.management,
          attempts: createUploadWorkers.mock.results.at(-1).value.attempts,
          worker: { hostId: 'cpu-1', instanceId: 'fixture-app' },
        }),
      );
      const processing = createUploadWorkers.mock.calls.at(-1)[0].processing;
      processing.observe({ stage: 'processing', seconds: 2, outcome: 'success' });
      processing.observe({ stage: 'total', seconds: 9, outcome: 'success' });
      const text = await registry.metrics();
      expect(text).toContain('cortex_upload_admissions_paused{slot="cpu-1"} 1');
      expect(text).toContain(
        'cortex_upload_quota_rejections_total{slot="cpu-1",reason="window"} 1',
      );
      expect(text).toContain('cortex_upload_retries_total{slot="cpu-1",reason="processing"} 1');
      expect(text).toContain(
        'cortex_upload_duration_seconds_sum{slot="cpu-1",stage="processing",outcome="success"} 2',
      );
      expect(text).toContain(
        'cortex_upload_duration_seconds_sum{slot="cpu-1",stage="total",outcome="success"} 9',
      );
      expect(text).not.toContain('tenant-a');
      expect(text).not.toContain('user-a');
      let release;
      const platformOriginal = new Promise((resolve) => {
        release = resolve;
      });
      platform.start = jest.fn(() => platformOriginal);
      const workers = createUploadWorkers.mock.results.at(-1).value;
      const startWorkers = jest.spyOn(workers, 'start').mockImplementation(() => {});
      const starting = composition.start();
      const reason = new Error('Original web startup cancelled during platform start');
      try {
        await new Promise((resolve) => setImmediate(resolve));
        expect(platform.start).toHaveBeenCalledTimes(1);
        expect(composition.start()).toBe(starting);
        expect(startWorkers).not.toHaveBeenCalled();
        startupController.abort(reason);
      } finally {
        release();
      }
      await expect(starting).rejects.toBe(reason);
      expect(startWorkers).not.toHaveBeenCalled();
    } finally {
      // This fixture lacks an actor reconciliation census; close must retain that uncertainty.
      await expect(composition.close(new AbortController().signal)).rejects.toThrow(
        'Upload shutdown has unresolved work',
      );
    }
  });
});
