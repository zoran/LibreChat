/** Original startup lifecycle assertions; external domain ports remain controlled. */
const { UploadManagementError } = require('../../../packages/api/src/uploads/errors');
describe('Upload startup admission at the actual composition', () => {
  function fixture(enabled = true) {
    const fs = require('node:fs');
    const vm = require('node:vm');
    let paused;
    const maintenance = {
      pauseAdmissions: jest.fn((id) => {
        paused = id;
        return true;
      }),
      resumeAdmissions: jest.fn((id) => {
        if (paused !== id) return false;
        paused = undefined;
        return true;
      }),
      getMaintenanceCensus: jest.fn(async (id) => ({
        admissionClosed: paused === id,
        queuedContinuations: 0,
        pendingWrites: 0,
        complete: true,
      })),
    };
    let finishIntake;
    let intakePaused;
    const intake = {
      maintenance: {
        pauseAdmissions: jest.fn((id) => {
          intakePaused = id;
          return true;
        }),
        resumeAdmissions: jest.fn((id) => {
          if (intakePaused !== id) return false;
          intakePaused = undefined;
          return true;
        }),
        getMaintenanceCensus: jest.fn(async (id) => ({
          admissionClosed: intakePaused === id,
          queuedContinuations: 0,
          pendingWrites: 0,
          complete: true,
        })),
      },
      close: jest.fn(async () => ({ complete: true })),
    };
    const workers = {
      maintenance,
      attempts: {},
      settlement: {},
      start: jest.fn(),
      close: jest.fn(async () => ({ complete: true })),
    };
    const platform = {
      resources: {},
      snapshots: {},
      hardGuards() {},
      readStorageBackend: jest.fn(() => undefined),
    };
    const api = new Proxy(
      {
        createUploadWorkers: () => workers,
        createManagedS3Storage: jest.fn(() => ({})),
        getManagedS3Provider: jest.fn(() => ({ state: 'unavailable' })),
        createUploadHttpRouter: jest.fn(() => ({})),
        UploadManagementError,
        composeManagedFileMaintenance: () => maintenance,
        createUploadRuntime: () => ({ status: () => ({}), start: jest.fn(), stop: jest.fn() }),
        createUploadLiveHub: () => ({ close: jest.fn() }),
        createUploadMetrics: () => ({ bind: () => ({}) }),
        getEmailCodeSettings: () => ({ tenantId: 'fixture' }),
        getRemainingShutdownMs: () => 30_000,
        createManagedFileRetrieval: async () => undefined,
        createHttpUploadSecurityPort: () => ({
          policySha256: 'a'.repeat(64),
          prepare() {},
          inspect() {},
          cancel() {},
        }),
        startIntakeControlService: jest.fn(
          () =>
            new Promise((resolve) => {
              finishIntake = resolve;
            }),
        ),
      },
      { get: (value, key) => (key in value ? value[key] : () => ({})) },
    );
    const env = {
      CORTEX_UPLOAD_MANAGEMENT_ENABLED: String(enabled),
      BUILD_COMMIT: 'a'.repeat(40),
      POD_UID: '12345678-1234-4234-8234-123456789012',
      POD_NODE_NAME: 'cpu-2',
      DOMAIN_CLIENT: 'https://fixture.example.test',
      UPLOAD_SECURITY_ENDPOINT: 'https://intake.example.test',
      UPLOAD_SECURITY_POLICY_SHA256: 'a'.repeat(64),
      UPLOAD_SECURITY_ALLOWED_HOSTS: 'intake.example.test',
    };
    for (const name of ['CA', 'CERT', 'KEY'])
      env[`UPLOAD_SECURITY_TLS_${name}_FILE`] = `/fixture/${name}`;
    const files = {
      mkdir: jest.fn(async () => {}),
      readFile: async () => Buffer.from('fixture'),
      lstat: async () => ({
        isDirectory: () => true,
        isSymbolicLink: () => false,
        uid: 123,
        mode: 0o700,
      }),
    };
    const modules = {
      '@librechat/api': api,
      '@librechat/data-schemas': {
        runAsSystem: (work) => work(),
        logger: {},
        createUploadManagementRepository: () => ({ initialize: async () => {} }),
      },
      'node:fs/promises': files,
      'node:path': require('node:path'),
      jsonwebtoken: {},
      mongoose: {},
      '~/models': {},
      './UploadIntake': {
        managedIntakeControlConfig: async () => ({}),
        createUploadTicketIssuer: () => ({}),
      },
      './UploadsNas': {
        managedSecurityClient: async () => api.createHttpUploadSecurityPort(),
        createLegacyUploadStorage: () => api.createManagedS3Storage(),
        selectedManagedUploads: async () => undefined,
        nasAntivirusAdmission: () => {
          throw new Error('NAS is not selected in this lifecycle fixture');
        },
        createNormalNasStorage: jest.requireActual(
          '../../../packages/api/src/uploads/composition/storage',
        ).createNormalUploadStorage,
      },
      './UploadPlatform': {
        createUploadPlatform: async () => platform,
      },
    };
    const module = { exports: {} };
    vm.runInNewContext(
      fs.readFileSync(require('node:path').join(__dirname, 'Uploads.js'), 'utf8'),
      {
        require: (id) => {
          if (!(id in modules)) throw new Error(`Unexpected dependency: ${id}`);
          return modules[id];
        },
        module,
        process: { env, getuid: () => 123 },
        Buffer,
        URL,
        AbortSignal,
      },
    );
    return {
      ...module.exports,
      api,
      files,
      workers,
      platform,
      intake,
      settleIntake: () => finishIntake(intake),
      identity: {
        source: env.BUILD_COMMIT,
        podUid: env.POD_UID,
        incarnation: '52345678-1234-4234-8234-123456789012',
      },
    };
  }

  it('keeps an uninitialized owner unknown and proves disabled absence only through acquisition', async () => {
    const f = fixture(false);
    expect(f.uploadMaintenance.readStorageProvider()).toEqual({ state: 'uninitialized' });
    expect(f.uploadMaintenance.pauseAdmissions('startup')).toBe(true);
    expect(await f.uploadMaintenance.getMaintenanceCensus('startup')).toMatchObject({
      admissionClosed: true,
      complete: false,
    });
    expect(f.uploadMaintenance.resumeAdmissions('startup')).toBe(false);
    await f.initializeUploads({});
    expect(f.uploadMaintenance.readStorageProvider()).toEqual({ state: 'disabled' });
    expect(f.api.getManagedS3Provider).not.toHaveBeenCalled();
    expect(await f.uploadMaintenance.getMaintenanceCensus('startup')).toMatchObject({
      admissionClosed: true,
      complete: true,
    });
    expect(f.files.mkdir).not.toHaveBeenCalled();
    expect(f.api.startIntakeControlService).not.toHaveBeenCalled();
    expect(f.uploadMaintenance.resumeAdmissions('startup')).toBe(true);
  });

  it('keeps partial acquisition and closing unqualified without adopting a missing web backend', async () => {
    const f = fixture();
    const opening = f.initializeUploads({ identity: f.identity });
    expect(f.uploadMaintenance.readStorageProvider()).toEqual({ state: 'unavailable' });
    expect(f.api.getManagedS3Provider).not.toHaveBeenCalled();
    const runtime = await opening;
    expect(f.uploadMaintenance.readStorageProvider()).toEqual({ state: 'unavailable' });
    expect(f.api.getManagedS3Provider).toHaveBeenLastCalledWith(
      f.api.createManagedS3Storage.mock.results[0].value,
      undefined,
    );
    expect(f.platform.readStorageBackend).toHaveBeenCalledTimes(1);
    const reads = f.api.getManagedS3Provider.mock.calls.length;
    const closing = runtime.close(new AbortController().signal);
    expect(f.uploadMaintenance.readStorageProvider()).toEqual({ state: 'unavailable' });
    expect(f.api.getManagedS3Provider).toHaveBeenCalledTimes(reads);
    await closing;
    expect(f.uploadMaintenance.readStorageProvider()).toEqual({ state: 'unavailable' });
  });

  it('preserves original startup failure through rejected composition cleanup', async () => {
    const f = fixture();
    f.uploadMaintenance.pauseAdmissions('startup');
    f.workers.maintenance.pauseAdmissions.mockReturnValueOnce(false);
    f.workers.close.mockRejectedValueOnce(new Error('Original cleanup failed'));
    await expect(f.initializeUploads({ identity: f.identity })).rejects.toThrow(
      'Upload startup admission closure unconfirmed',
    );
    expect(f.workers.close).toHaveBeenCalledTimes(1);
    expect(f.api.startIntakeControlService).not.toHaveBeenCalled();
    expect(f.uploadMaintenance.readStorageProvider()).toEqual({ state: 'unavailable' });
    expect(await f.uploadMaintenance.getMaintenanceCensus('startup')).toMatchObject({
      complete: false,
    });
  });

  it('inherits the initial hold and joins the original late intake acquisition before cleanup', async () => {
    const f = fixture();
    f.uploadMaintenance.pauseAdmissions('startup');
    const runtime = await f.initializeUploads({ identity: f.identity });
    expect(f.workers.maintenance.pauseAdmissions).toHaveBeenCalledWith('startup');
    expect(f.api.startIntakeControlService).not.toHaveBeenCalled();
    await expect(runtime.start()).rejects.toThrow('Upload startup admission is closed');
    expect(f.uploadMaintenance.resumeAdmissions('startup')).toBe(true);
    const original = runtime.start();
    expect(runtime.start()).toBe(original);
    await Promise.resolve();
    expect(f.api.startIntakeControlService).toHaveBeenCalledTimes(1);
    expect(await f.uploadMaintenance.getMaintenanceCensus(null)).toMatchObject({
      pendingWrites: 1,
    });
    const closing = runtime.close(new AbortController().signal);
    expect(runtime.close(new AbortController().signal)).toBe(closing);
    await Promise.resolve();
    expect(f.intake.close).not.toHaveBeenCalled();
    expect(await f.uploadMaintenance.getMaintenanceCensus('shutdown')).toMatchObject({
      admissionClosed: true,
      pendingWrites: 2,
    });
    f.settleIntake();
    await expect(original).rejects.toThrow('Upload shutdown precedes runtime dispatch');
    await closing;
    expect(f.workers.start).not.toHaveBeenCalled();
    expect(f.intake.close).toHaveBeenCalledTimes(1);
    expect(f.intake.maintenance.pauseAdmissions).toHaveBeenCalledWith('shutdown');
    expect(f.workers.close).toHaveBeenCalledTimes(1);
  });

  it('holds browser and writable GET originals across pause and a bounded close', async () => {
    const f = fixture();
    const runtime = await f.initializeUploads({ identity: f.identity });
    expect(f.api.createUploadHttpRouter.mock.calls[0][0].runFileOperation).toBe(
      runtime.runFileOperation,
    );
    let release;
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const original = runtime.runFileOperation(async () => {
      entered();
      await new Promise((resolve) => {
        release = resolve;
      });
      return 'committed after disconnect';
    });
    await started;
    expect(f.uploadMaintenance.pauseAdmissions('maintenance')).toBe(true);
    const forbidden = jest.fn();
    await expect(runtime.runFileOperation(forbidden)).rejects.toMatchObject({
      code: 'admission_paused',
    });
    expect(forbidden).not.toHaveBeenCalled();
    expect(await f.uploadMaintenance.getMaintenanceCensus('maintenance')).toMatchObject({
      admissionClosed: true,
      pendingWrites: 1,
    });
    await expect(runtime.close(AbortSignal.abort())).rejects.toThrow(
      'Upload shutdown has unresolved original work',
    );
    expect(await f.uploadMaintenance.getMaintenanceCensus('maintenance')).toMatchObject({
      pendingWrites: 1,
    });
    release();
    await expect(original).resolves.toBe('committed after disconnect');
    expect(await f.uploadMaintenance.getMaintenanceCensus('maintenance')).toMatchObject({
      pendingWrites: 0,
    });
    expect(f.uploadMaintenance.resumeAdmissions('maintenance')).toBe(false);
  });

  it('joins live intake originals and keeps its actual close visible until settlement', async () => {
    const f = fixture();
    const runtime = await f.initializeUploads({ identity: f.identity });
    const starting = runtime.start();
    await Promise.resolve();
    f.settleIntake();
    await starting;
    expect(f.uploadMaintenance.pauseAdmissions('maintenance')).toBe(true);
    f.intake.maintenance.getMaintenanceCensus.mockResolvedValue({
      admissionClosed: true,
      queuedContinuations: 0,
      pendingWrites: 1,
      complete: true,
    });
    expect(await f.uploadMaintenance.getMaintenanceCensus('maintenance')).toMatchObject({
      pendingWrites: 1,
    });
    let release;
    let entered;
    const enteredClose = new Promise((resolve) => {
      entered = resolve;
    });
    f.intake.close.mockImplementation(async () => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const closing = runtime.close(new AbortController().signal);
    await enteredClose;
    expect(await f.uploadMaintenance.getMaintenanceCensus('maintenance')).toMatchObject({
      pendingWrites: 2,
    });
    f.intake.maintenance.getMaintenanceCensus.mockResolvedValue({
      admissionClosed: true,
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
    release({ complete: true });
    await closing;
    expect(await f.uploadMaintenance.getMaintenanceCensus('maintenance')).toMatchObject({
      pendingWrites: 0,
    });
  });
});
