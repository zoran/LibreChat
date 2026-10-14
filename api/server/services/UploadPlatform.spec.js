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
