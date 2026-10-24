jest.mock('node:fs/promises', () => ({ readFile: jest.fn() }));
jest.mock('@librechat/api', () => ({
  createUploadPlatformRuntime: jest.fn((options) => options),
  parseUploadBackendBinding: jest.fn(),
}));
jest.mock('@librechat/data-schemas', () => ({ runAsSystem: jest.fn((operation) => operation()) }));
const { readFile } = require('node:fs/promises');
const { createUploadPlatformRuntime } = require('@librechat/api');
const { runAsSystem } = require('@librechat/data-schemas');
const { createUploadPlatform } = require('./UploadPlatform');

describe('LibreChat upload platform configuration', () => {
  let previous;
  beforeEach(() => {
    previous = { ...process.env };
    process.env.CORTEX_UPLOAD_EXPECTED_HOSTS = JSON.stringify([
      'host-1',
      'host-2',
      'host-3',
      'host-4',
    ]);
    delete process.env.CORTEX_UPLOAD_RESOURCE_COLLECTORS;
    delete process.env.CORTEX_UPLOAD_BACKEND_CONFIG;
    readFile.mockReset();
    createUploadPlatformRuntime.mockClear();
    runAsSystem.mockClear();
  });
  afterEach(() => {
    process.env = previous;
  });
  it('leaves absent native qualification unavailable and runs only the exact repository projection as system', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('absent'), { code: 'ENOENT' }));
    const repository = { localReservations: jest.fn(async () => ({ heldBytes: 1 })) };
    const worker = { hostId: 'host-2', instanceId: 'pod-2' };
    const options = await createUploadPlatform({
      repository,
      worker,
      stagingRoot: '/trusted/staging',
    });
    expect(options.backendBinding).toBeUndefined();
    expect(options.tls).toBeUndefined();
    await options.repository.localReservations(worker, 123);
    expect(repository.localReservations).toHaveBeenCalledWith(worker, 123);
    expect(runAsSystem).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledTimes(1);
  });
  it('does not treat malformed explicit backend input as an absent native owner', async () => {
    readFile.mockResolvedValue(Buffer.from('{broken'));
    await expect(
      createUploadPlatform({ repository: {}, worker: {}, stagingRoot: '/trusted' }),
    ).rejects.toThrow('Invalid upload safety binding');
    expect(createUploadPlatformRuntime).not.toHaveBeenCalled();
  });
});

describe('actual platform provider capture', () => {
  function options(
    parseUploadBackendBinding = jest.requireActual(
      '../../../packages/api/src/uploads/platform/backend',
    ).parseUploadBackendBinding,
  ) {
    const expectedHosts = ['host-1', 'host-2', 'host-3', 'host-4'];
    const backendBinding = parseUploadBackendBinding(
      {
        schema: 1,
        deploymentId: 'deployment',
        storeId: 'store',
        bucket: 'cortex-managed-uploads',
        collection: 'managed',
        observers: [
          { observer: 'cpu-2', name: 'cortex-upload-safety-cpu-2', uid: 'observer-2' },
          { observer: 'cpu-4', name: 'cortex-upload-safety-cpu-4', uid: 'observer-4' },
        ],
        policy: {
          revision: 'revision',
          sourceSha256: 'a'.repeat(64),
          filers: [
            { member: 'filer-1', podUid: 'filer-pod-1', processId: 'containerd://filer-1' },
            { member: 'filer-4', podUid: 'filer-pod-4', processId: 'containerd://filer-4' },
          ],
        },
        filesystems: expectedHosts.map((hostId) => ({
          hostId,
          pvUid: `${hostId}-pv`,
          filesystemId: `${hostId}-fs`,
        })),
      },
      expectedHosts,
    );
    return {
      expectedHosts,
      backendBinding,
      repository: { localReservations: jest.fn() },
      worker: { hostId: 'host-1', instanceId: 'platform-test' },
      stagingRoot: '/fixture/staging',
      parserSocketPath: '/fixture/parser.sock',
    };
  }

  it('shares the exact immutable parsed copy with the backend and invalidates before close settles', async () => {
    const backendOwner = jest.requireActual(
      '../../../packages/api/src/uploads/platform/backendClient',
    );
    const create = jest.spyOn(backendOwner, 'createUploadBackendClient');
    const { createUploadPlatformRuntime: actual } = jest.requireActual(
      '../../../packages/api/src/uploads/platform/runtime',
    );
    const input = options();
    const first = actual(input);
    const second = actual(input);
    try {
      const captured = first.readStorageBackend();
      expect(captured.binding).toBe(create.mock.calls[0][0].binding);
      expect(captured.binding).not.toBe(input.backendBinding);
      expect(captured.instanceId).not.toBe(second.readStorageBackend().instanceId);
      expect(Object.isFrozen(captured)).toBe(true);
      expect(Object.isFrozen(captured.binding.policy.filers[0])).toBe(true);
      expect(Object.isFrozen(captured.binding.filesystems)).toBe(true);
      input.backendBinding.policy.revision = 'later-configmap-revision';
      input.backendBinding.filesystems[0].pvUid = 'later-pv';
      expect(first.readStorageBackend().binding.policy.revision).toBe('revision');
      expect(first.readStorageBackend().binding.filesystems[0].pvUid).toBe('host-1-pv');
      const closing = first.close();
      expect(first.readStorageBackend()).toBeUndefined();
      expect(second.readStorageBackend()).toBeDefined();
      await closing;
      expect(first.readStorageBackend()).toBeUndefined();
      expect(input.repository.localReservations).not.toHaveBeenCalled();
    } finally {
      await first.close();
      await second.close();
      create.mockRestore();
    }
  });

  it('keeps platform custody invalid after a failing close callback', async () => {
    const backendOwner = jest.requireActual(
      '../../../packages/api/src/uploads/platform/backendClient',
    );
    const construct = backendOwner.createUploadBackendClient;
    const failure = new Error('fixture close failed');
    let platform;
    const spy = jest
      .spyOn(backendOwner, 'createUploadBackendClient')
      .mockImplementation((input) => {
        const owned = construct(input);
        return {
          ...owned,
          close: async () => {
            expect(platform.readStorageBackend()).toBeUndefined();
            await owned.close();
            throw failure;
          },
        };
      });
    try {
      const { createUploadPlatformRuntime: actual } = jest.requireActual(
        '../../../packages/api/src/uploads/platform/runtime',
      );
      platform = actual(options());
      expect(platform.readStorageBackend()).toBeDefined();
      const closing = platform.close();
      expect(platform.readStorageBackend()).toBeUndefined();
      await expect(closing).rejects.toBe(failure);
      expect(platform.readStorageBackend()).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps a platform without an actual backend unavailable', async () => {
    const { createUploadPlatformRuntime: actual } = jest.requireActual(
      '../../../packages/api/src/uploads/platform/runtime',
    );
    const platform = actual({ ...options(), backendBinding: undefined });
    try {
      expect(platform.readStorageBackend()).toBeUndefined();
    } finally {
      await platform.close();
    }
  });

  it('preserves actual compiled public provider custody through census replacement and close', async () => {
    const previousEnv = { ...process.env };
    jest.dontMock('@librechat/data-schemas');
    jest.dontMock('node:fs/promises');
    try {
      await jest.isolateModulesAsync(async () => {
        const { realpathSync } = jest.requireActual('node:fs');
        const { resolve } = jest.requireActual('node:path');
        const api = jest.requireActual('@librechat/api');
        const housekeeping = jest.requireActual('@librechat/api/housekeeping');
        const platforms = [];
        const clients = [];
        const closing = [];
        let maintenance;
        let pendingStatus;
        let releaseCensus;
        let failure;
        let failures = [];
        try {
          expect(realpathSync(require.resolve('@librechat/api'))).toBe(
            resolve(__dirname, '../../../packages/api/dist/index.cjs'),
          );
          expect(realpathSync(require.resolve('@librechat/api/housekeeping'))).toBe(
            resolve(__dirname, '../../../packages/api/dist/housekeeping.cjs'),
          );
          for (const name of [
            'parseUploadBackendBinding',
            'createUploadPlatformRuntime',
            'createManagedS3Client',
            'createManagedS3Storage',
            'getManagedS3Provider',
            'createMaintenanceIdentity',
            'createWorkloadMaintenance',
          ]) {
            expect(typeof api[name]).toBe('function');
            expect(jest.isMockFunction(api[name])).toBe(false);
          }
          for (const name of [
            'createManagedS3Client',
            'createManagedS3Storage',
            'getManagedS3Provider',
          ]) {
            expect(typeof housekeeping[name]).toBe('function');
            expect(jest.isMockFunction(housekeeping[name])).toBe(false);
          }
          const input = options(api.parseUploadBackendBinding);
          const storageEnv = {
            AWS_REGION: 'fixture',
            AWS_BUCKET_NAME: 'cortex-managed-uploads',
            AWS_ENDPOINT_URL: 'https://storage.example.test',
            AWS_FORCE_PATH_STYLE: 'true',
            AWS_ACCESS_KEY_ID: 'fixture-key',
            AWS_SECRET_ACCESS_KEY: 'fixture-secret',
          };
          const web = [0, 1].map(() => {
            const platform = api.createUploadPlatformRuntime(input);
            platforms.push(platform);
            const client = api.createManagedS3Client(storageEnv);
            clients.push(client);
            const storage = api.createManagedS3Storage({
              client,
              bucket: 'cortex-managed-uploads',
            });
            const captured = api.getManagedS3Provider(storage, platform.readStorageBackend());
            return { platform, client, storage, captured };
          });
          const hkClient = housekeeping.createManagedS3Client(storageEnv);
          clients.push(hkClient);
          const hkStorage = housekeeping.createManagedS3Storage({
            client: hkClient,
            bucket: 'cortex-managed-uploads',
          });
          const hkCaptured = housekeeping.getManagedS3Provider(hkStorage, null);
          expect(hkCaptured).toMatchObject({ state: 'captured', backend: null });
          expect(api.getManagedS3Provider(hkStorage, null)).toEqual(hkCaptured);
          for (const { platform, storage, captured } of web) {
            expect(captured.state).toBe('captured');
            expect(
              housekeeping.getManagedS3Provider(storage, platform.readStorageBackend()),
            ).toEqual(captured);
            expect(Object.isFrozen(captured)).toBe(true);
            expect(Object.isFrozen(captured.client)).toBe(true);
            expect(Object.isFrozen(captured.commands)).toBe(true);
            expect(Object.isFrozen(captured.backend.binding.policy.filers[0])).toBe(true);
          }
          const ids = [...web.map(({ captured }) => captured), hkCaptured].flatMap((captured) => [
            captured.client.instanceId,
            captured.commands.instanceId,
            ...(captured.backend ? [captured.backend.instanceId] : []),
          ]);
          expect(ids).toHaveLength(8);
          expect(new Set(ids).size).toBe(ids.length);
          for (const id of ids)
            expect(id).toMatch(
              /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
            );
          for (const key of ['client', 'commands', 'backend']) {
            const { instanceId: firstId, ...firstConfig } = web[0].captured[key];
            const { instanceId: secondId, ...secondConfig } = web[1].captured[key];
            expect(firstId).not.toBe(secondId);
            expect(firstConfig).toEqual(secondConfig);
          }
          const env = {
            LIBRECHAT_MAINTENANCE_TOKEN: 'w'.repeat(32),
            POD_UID: '12345678-1234-1234-1234-123456789012',
            BUILD_COMMIT: 'b'.repeat(40),
          };
          const identity = api.createMaintenanceIdentity(env, true);
          let current = web[0];
          let paused = null;
          let censusGate;
          const owner = {
            pauseAdmissions: (id) => {
              paused = id;
              return true;
            },
            resumeAdmissions: () => {
              paused = null;
              return true;
            },
            getMaintenanceCensus: async (id) => {
              const gate = censusGate;
              censusGate = undefined;
              if (gate) {
                gate.entered();
                await gate.wait;
              }
              return {
                admissionClosed: id !== null && id === paused,
                queuedContinuations: 0,
                pendingWrites: 0,
                complete: true,
              };
            },
          };
          maintenance = api.createWorkloadMaintenance({
            env,
            identity,
            workOwners: { owner },
            fileDomainOwners: ['owner'],
            startupReady: () => true,
            readStorageProviders: () => ({
              ordinaryS3: { state: 'not-owned' },
              managedS3: api.getManagedS3Provider(
                current.storage,
                current.platform.readStorageBackend(),
              ),
            }),
          });
          const baseline = await maintenance.status();
          expect(baseline).toMatchObject({
            identity,
            requestId: null,
            revision: 0,
            known: true,
            fileDomain: { known: true },
            storageProviders: { ordinaryS3: { state: 'not-owned' }, managedS3: web[0].captured },
          });
          let entered;
          const enteredCensus = new Promise((resolveEntered) => {
            entered = resolveEntered;
          });
          const wait = new Promise((resolveCensus) => {
            releaseCensus = resolveCensus;
          });
          censusGate = { entered, wait };
          pendingStatus = maintenance.status();
          await enteredCensus;
          current = web[1];
          releaseCensus();
          expect(await pendingStatus).toMatchObject({
            identity,
            requestId: baseline.requestId,
            revision: baseline.revision,
            known: false,
            census: null,
            fileDomain: { known: false, census: null },
            storageProviders: {
              ordinaryS3: { state: 'unavailable' },
              managedS3: { state: 'unavailable' },
            },
          });
          expect(await maintenance.status()).toMatchObject({
            identity,
            requestId: null,
            revision: 0,
            known: true,
            fileDomain: { known: true },
            storageProviders: { ordinaryS3: { state: 'not-owned' }, managedS3: web[1].captured },
          });
          for (const { platform, storage } of web) {
            closing.push(platform.close());
            expect(platform.readStorageBackend()).toBeUndefined();
            expect(api.getManagedS3Provider(storage, platform.readStorageBackend())).toEqual({
              state: 'unavailable',
            });
            expect(
              housekeeping.getManagedS3Provider(storage, platform.readStorageBackend()),
            ).toEqual({ state: 'unavailable' });
          }
          expect(api.getManagedS3Provider(hkStorage, null)).toEqual(hkCaptured);
          expect(housekeeping.getManagedS3Provider(hkStorage, null)).toEqual(hkCaptured);
          expect(await maintenance.status()).toMatchObject({
            known: true,
            fileDomain: { known: true },
            storageProviders: {
              ordinaryS3: { state: 'not-owned' },
              managedS3: { state: 'unavailable' },
            },
          });
          for (const { client, storage, captured } of [
            ...web,
            { client: hkClient, storage: hkStorage, captured: hkCaptured },
          ]) {
            client.destroy();
            expect(api.getManagedS3Provider(storage, captured.backend)).toEqual({
              state: 'unavailable',
            });
            expect(housekeeping.getManagedS3Provider(storage, captured.backend)).toEqual({
              state: 'unavailable',
            });
          }
          expect(web[0].captured.state).toBe('captured');
        } catch (error) {
          failure = error;
        } finally {
          releaseCensus?.();
          const cleanup = await Promise.allSettled([
            ...closing,
            ...(pendingStatus ? [pendingStatus] : []),
            ...(maintenance ? [Promise.resolve().then(() => maintenance.close())] : []),
            ...platforms.map((platform) => Promise.resolve().then(() => platform.close())),
            ...clients.map((client) => Promise.resolve().then(() => client.destroy())),
          ]);
          failures = cleanup
            .filter((result) => result.status === 'rejected')
            .map((result) => result.reason);
        }
        if (failure && failures.length)
          throw new AggregateError(
            [failure, ...failures],
            'Public provider flow and cleanup failed',
            { cause: failure },
          );
        if (failure) throw failure;
        if (failures.length)
          throw new AggregateError(failures, 'Public provider flow cleanup failed');
      });
    } finally {
      jest.doMock('@librechat/data-schemas', () => ({ runAsSystem }));
      jest.doMock('node:fs/promises', () => ({ readFile }));
      process.env = previousEnv;
    }
  });

  it('refuses secret-bearing extras, invalid scalar strings and an over-bound total provider frame', async () => {
    const { observeStorageProviders } = jest.requireActual(
      '../../../packages/api/src/storage/providerObservation',
    );
    const { createUploadPlatformRuntime: actual } = jest.requireActual(
      '../../../packages/api/src/uploads/platform/runtime',
    );
    const { createManagedS3Client } = jest.requireActual(
      '../../../packages/api/src/storage/s3/managedClient',
    );
    const { createManagedS3Storage, getManagedS3Provider } = jest.requireActual(
      '../../../packages/api/src/storage/s3/managed',
    );
    const platform = actual(options());
    const client = createManagedS3Client({
      AWS_REGION: 'fixture',
      AWS_BUCKET_NAME: 'cortex-managed-uploads',
      AWS_ENDPOINT_URL: 'https://storage.example.test',
      AWS_FORCE_PATH_STYLE: 'true',
      AWS_ACCESS_KEY_ID: 'fixture-key',
      AWS_SECRET_ACCESS_KEY: 'fixture-secret',
    });
    try {
      const storage = createManagedS3Storage({ client, bucket: 'cortex-managed-uploads' });
      const managed = getManagedS3Provider(storage, platform.readStorageBackend());
      expect(managed.state).toBe('captured');
      const value = { ordinaryS3: { state: 'not-owned' }, managedS3: managed };
      expect(observeStorageProviders(() => value)).toEqual(value);
      const extra = JSON.parse(JSON.stringify(value));
      extra.managedS3.backend.binding.credentials = 'fixture-secret';
      expect(observeStorageProviders(() => extra)).toBeUndefined();
      const scalar = JSON.parse(JSON.stringify(value));
      scalar.managedS3.client.region = '\ud800';
      expect(observeStorageProviders(() => scalar)).toBeUndefined();
      const bytes = JSON.parse(JSON.stringify(value));
      bytes.managedS3.commands.bucket = 'é'.repeat(128);
      expect(observeStorageProviders(() => bytes)).toBeUndefined();
      bytes.managedS3.commands.bucket = 'é'.repeat(127);
      expect(observeStorageProviders(() => bytes)).toBeDefined();
      const large = JSON.parse(JSON.stringify(value));
      const root = 'https://' + 'a'.repeat(2040);
      large.managedS3.client.endpoint = root;
      const binding = large.managedS3.backend.binding;
      for (const key of ['deploymentId', 'storeId', 'collection']) binding[key] = 'x'.repeat(128);
      binding.policy.revision = 'x'.repeat(128);
      binding.observers.forEach((row, i) => {
        row.uid = String(i) + 'x'.repeat(127);
      });
      binding.filesystems.forEach((row, i) => {
        row.pvUid = String(i) + 'x'.repeat(127);
        row.filesystemId = 'x'.repeat(128);
      });
      binding.policy.filers.forEach((row, i) => {
        row.podUid = String(i) + 'x'.repeat(127);
        row.processId = 'x'.repeat(256);
      });
      large.ordinaryS3 = {
        state: 'captured',
        client: { ...managed.client, endpoint: root },
        commands: { ...managed.commands, endpoint: root, forcePathStyle: true },
      };
      expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(8192);
      expect(observeStorageProviders(() => large)).toBeUndefined();
      expect(JSON.stringify(observeStorageProviders(() => value))).not.toContain('fixture-secret');
    } finally {
      client.destroy();
      await platform.close();
    }
  });
});
