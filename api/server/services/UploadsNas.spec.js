/** Genuine NAS deployment/router with synthetic local inputs; platform/NFS effects remain inert. */
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const path = require('node:path');
jest.mock(
  '@librechat/api',
  () => ({
    ...jest.requireActual('../../../packages/api/src/uploads/composition/storage'),
    ...jest.requireActual('../../../packages/api/src/storage/uploads'),
  }),
  { virtual: true },
);
jest.mock('./Config/app', () => ({ getAppConfig: jest.fn() }));
const { getNasS3StorageCapture } = require('../../../packages/api/src/storage/nas/storage');
const { createNormalNasStorage, selectedManagedUploads } = require('./UploadsNas');
let root;
const opened = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(process.env.NAS_TEST_TMPDIR, 'normal-nas-'));
});
afterEach(async () => {
  for (const item of opened.splice(0)) await item.close();
  await rm(root, { recursive: true });
});
const managedStorage = { put: jest.fn(), read: jest.fn() };
const repository = {};
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
  const storageAvailability = { assertSafe: jest.fn() };
  const createUploadPlatform = jest.fn(async ({ nas }) => {
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
  opened.push(value);
  expect(value.managedCleanup).toBe(managedStorage);
  expect(getNasS3StorageCapture(value.nasStorage)).toBeDefined();
  expect(value.storage).not.toBe(value.nasStorage);
  expect(value.platform.storageAvailability).toBe(storageAvailability);
  await value.close();
  expect(getNasS3StorageCapture(value.nasStorage)).toBeUndefined();
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
