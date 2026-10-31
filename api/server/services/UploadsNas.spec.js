/** Genuine NAS deployment/router with synthetic local inputs; platform/NFS effects remain inert. */
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { realpathSync } = require('node:fs');
const { performance } = require('node:perf_hooks');
const path = require('node:path');
jest.mock(
  '@librechat/api',
  () => {
    const producer = jest.requireActual('../../../packages/api/src/uploads/composition/storage');
    const router = jest.requireActual('../../../packages/api/src/storage/uploads');
    const graph = {
      producer,
      router,
      storage: jest.requireActual('../../../packages/api/src/storage/nas/storage'),
      barrel: jest.requireActual('../../../packages/api/src/storage/nas'),
      client: jest.requireActual('../../../packages/api/src/storage/nas/client'),
    };
    return { ...producer, ...router, __nasFixtureGraph: graph };
  },
  { virtual: true },
);
jest.mock('./Config/app', () => ({ getAppConfig: jest.fn() }));
const { getNasS3StorageCapture } = require('../../../packages/api/src/storage/nas/storage');
const { createNormalNasStorage, selectedManagedUploads } = require('./UploadsNas');
let root;
let nasDiagnostic;
const opened = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(process.env.NAS_TEST_TMPDIR, 'normal-nas-'));
});
afterEach(async () => {
  try {
    for (const item of opened.splice(0)) await item.close();
    await rm(root, { recursive: true });
  } finally {
    const diagnostic = nasDiagnostic;
    nasDiagnostic = undefined;
    diagnostic?.finish();
  }
});
const managedStorage = { put: jest.fn(), read: jest.fn() };
const repository = {};

/** Observe the failing fixture graph without replacing its adapter or any capture result. */
function createNasDiagnostic() {
  const started = performance.now();
  let entry;
  try {
    entry = require('@librechat/api');
  } catch {
    // The original composition still owns module failure; observation is optional.
  }
  const graph = entry?.__nasFixtureGraph;
  const restores = [];
  const events = [];
  let adapter,
    returned,
    client,
    failureObserved = false,
    creates = 0,
    destroys = 0;
  let factorySpyInstalled = false,
    destroySpyInstalled = false;
  const actualCreate = graph?.client?.createNasS3Client;
  const identities = {
    graphCaptured: graph !== undefined,
    normalEntry: entry?.createNormalUploadStorage === createNormalNasStorage,
    producer: createNormalNasStorage === graph?.producer?.createNormalUploadStorage,
    router: require('@librechat/api').composeUploadStorage === graph?.router?.composeUploadStorage,
    ordinaryReader: getNasS3StorageCapture === graph?.storage?.getNasS3StorageCapture,
    barrelReader: graph?.barrel?.getNasS3StorageCapture === graph?.storage?.getNasS3StorageCapture,
    producerMock: jest.isMockFunction(graph?.producer?.createNormalUploadStorage),
    storageFactoryMock: jest.isMockFunction(graph?.storage?.createNasS3Storage),
    ordinaryReaderMock: jest.isMockFunction(getNasS3StorageCapture),
    actualReaderMock: jest.isMockFunction(graph?.storage?.getNasS3StorageCapture),
    barrelReaderMock: jest.isMockFunction(graph?.barrel?.getNasS3StorageCapture),
    clientFactoryMock: jest.isMockFunction(actualCreate),
    clientReaderMock: jest.isMockFunction(graph?.client?.getNasS3ClientCapture),
  };
  const checkout = path.resolve(__dirname, '../../..');
  const publicPath = (value) => {
    const relative = path.relative(checkout, value);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? relative.split(path.sep).join('/')
      : null;
  };
  const paths = Object.fromEntries(
    [
      '@librechat/api',
      '../../../packages/api/src/uploads/composition/storage',
      '../../../packages/api/src/storage/uploads',
      '../../../packages/api/src/storage/nas/storage',
      '../../../packages/api/src/storage/nas',
      '../../../packages/api/src/storage/nas/client',
    ].map((id) => {
      try {
        const resolved = require.resolve(id);
        const real = realpathSync(resolved);
        return [
          id,
          { resolved: publicPath(resolved), real: publicPath(real), same: resolved === real },
        ];
      } catch {
        return [id, { resolved: null, real: null, same: false }];
      }
    }),
  );
  const capture = (reader, value) => {
    try {
      return { defined: value !== undefined && reader(value) !== undefined, threw: false };
    } catch {
      return { defined: false, threw: true };
    }
  };
  const note = (phase) => {
    if (events.length >= 16) return;
    events.push({
      phase,
      elapsedMs: Math.min(60000, Math.max(0, Math.round(performance.now() - started))),
      creates,
      destroys,
      adapterPresent: adapter !== undefined,
      returnedAlias: returned !== undefined && returned.nasStorage === adapter,
      cleanupAlias: returned !== undefined && returned.nasCleanup === adapter,
      ordinary: capture(getNasS3StorageCapture, adapter),
      actual: capture(graph?.storage?.getNasS3StorageCapture, adapter),
      barrel: capture(graph?.barrel?.getNasS3StorageCapture, adapter),
      client: capture(graph?.client?.getNasS3ClientCapture, client),
    });
  };
  try {
    if (typeof actualCreate !== 'function') throw new Error('Fixture graph was not captured');
    const createSpy = jest.spyOn(graph.client, 'createNasS3Client').mockImplementation(function (
      ...args
    ) {
      creates++;
      client = Reflect.apply(actualCreate, this, args);
      const actualDestroy = client.destroy;
      try {
        const destroySpy = jest.spyOn(client, 'destroy').mockImplementation(function (...values) {
          destroys++;
          note('destroy-called');
          try {
            return Reflect.apply(actualDestroy, this, values);
          } finally {
            note('destroy-returned');
          }
        });
        restores.push(() => destroySpy.mockRestore());
        destroySpyInstalled = true;
      } catch {
        // An unavailable observation never changes the actual client or its return value.
      }
      note('client-created');
      return client;
    });
    restores.push(() => createSpy.mockRestore());
    factorySpyInstalled = true;
  } catch {
    // Preserve the original assertion even when this module cannot be spied upon.
  }
  note('before-composition');
  return {
    nas(value) {
      adapter = value;
      note('platform-callback');
    },
    returned(value) {
      returned = value;
      note('composition-returned');
    },
    note,
    failed() {
      failureObserved = true;
    },
    finish() {
      note('after-cleanup');
      for (const restore of restores.reverse()) {
        try {
          restore();
        } catch {
          // Diagnostics cannot replace the original test failure.
        }
      }
      if (!failureObserved) return;
      const output = JSON.stringify({
        nasFixtureDiagnostic: {
          identities,
          paths,
          factorySpyInstalled,
          destroySpyInstalled,
          creates,
          destroys,
          events,
        },
      });
      try {
        process.stderr.write(
          Buffer.byteLength(output) <= 8192
            ? output + '\n'
            : '{"nasFixtureDiagnostic":{"outputBoundExceeded":true}}\n',
        );
      } catch {
        // Observation cannot replace the original test failure.
      }
    },
  };
}
async function configuration() {
  const credentialsFile = path.join(root, 'synthetic.json');
  await writeFile(
    credentialsFile,
    JSON.stringify({ schema: 1, accessKeyId: 'SYNTHETIC_ONLY', secretAccessKey: 'SYNTHETIC_ONLY' }),
    { mode: 0o600 },
  );
  return {
    storage: {
      kind: 'nas-s3',
      uid: 'nas1',
      endpoint: 'https://synthetic.invalid',
      bucket: 'synthetic-files',
      credentialsFile,
      trust: { mode: 'ca-hostname' },
    },
    health: { requiredHosts: ['cpu2', 'cpu3', 'cpu4', 'cpu5'] },
  };
}
it('reads private deployment selection from the normal base AppConfig owner', async () => {
  const privateConfig = { synthetic: true };
  require('./Config/app').getAppConfig.mockResolvedValue({
    managedUploads: privateConfig,
    fileConfig: {},
  });
  expect(await selectedManagedUploads()).toBe(privateConfig);
});
it('composes the real branded NAS cleanup adapter alongside the retained legacy backend', async () => {
  nasDiagnostic = createNasDiagnostic();
  try {
    const storageAvailability = { assertSafe: jest.fn() };
    const createUploadPlatform = jest.fn(async ({ nas }) => {
      nasDiagnostic.nas(nas.storage);
      expect(typeof nas.healthProbe('cpu2')).toBe('function');
      return { storageAvailability, close: jest.fn() };
    });
    const value = await createNormalNasStorage({
      configuration: await configuration(),
      repository,
      worker: { hostId: 'cpu2' },
      stagingRoot: root,
      managedStorage,
      createUploadPlatform,
      signal: new AbortController().signal,
    });
    nasDiagnostic.returned(value);
    opened.push(value);
    expect(value.managedCleanup).toBe(managedStorage);
    expect(getNasS3StorageCapture(value.nasStorage)).toBeDefined();
    expect(value.storage).not.toBe(value.nasStorage);
    expect(value.platform.storageAvailability).toBe(storageAvailability);
    nasDiagnostic.note('before-close');
    await value.close();
    nasDiagnostic.note('after-close');
    expect(getNasS3StorageCapture(value.nasStorage)).toBeUndefined();
  } catch (error) {
    nasDiagnostic.failed(error);
    throw error;
  }
});
it('refuses a selected NAS when normal health composition is absent and never falls back', async () => {
  await expect(
    createNormalNasStorage({
      configuration: await configuration(),
      repository,
      worker: { hostId: 'cpu2' },
      stagingRoot: root,
      managedStorage,
      createUploadPlatform: async () => ({ close: jest.fn() }),
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('NAS storage health unavailable');
  expect(managedStorage.put).not.toHaveBeenCalled();
});
it('preserves the old backend when private NAS configuration is absent', async () => {
  const result = await createNormalNasStorage({
    managedStorage,
    createUploadPlatform: async () => ({ close: jest.fn() }),
  });
  opened.push(result);
  expect(result.storage).toBe(managedStorage);
  expect(result.nasStorage).toBeUndefined();
});

/** Only the external configuration acquisition is inert; the shipped selector and wiring run. */
function loadWithConfiguration(acquireConfiguration) {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'UploadsNas.js'), 'utf8'), {
    module,
    process: { env: {} },
    require: (id) => {
      if (id === '@librechat/api') return require('@librechat/api');
      if (id === './Config/app') return acquireConfiguration();
      throw new Error(`Unexpected dependency: ${id}`);
    },
  });
  return module.exports;
}
it('acquires AppConfig only at private storage selection, never while importing unrelated consumers', async () => {
  const privateConfig = { synthetic: true };
  const getAppConfig = jest.fn(async () => ({ managedUploads: privateConfig }));
  const acquireConfiguration = jest.fn(() => ({ getAppConfig }));
  const nas = loadWithConfiguration(acquireConfiguration);
  expect(acquireConfiguration).not.toHaveBeenCalled();
  expect(getAppConfig).not.toHaveBeenCalled();
  await expect(nas.selectedManagedUploads()).resolves.toBe(privateConfig);
  expect(acquireConfiguration).toHaveBeenCalledTimes(1);
  expect(getAppConfig).toHaveBeenCalledTimes(1);
});
it('propagates real configuration initialization failure without selecting a legacy fallback', async () => {
  const failure = new Error('Synthetic configuration initialization failure');
  const nas = loadWithConfiguration(() => {
    throw failure;
  });
  await expect(nas.selectedManagedUploads()).rejects.toBe(failure);
});
