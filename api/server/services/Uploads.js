const jwt = require('jsonwebtoken');
const { mkdir, lstat, readFile } = require('node:fs/promises');
const { isAbsolute } = require('node:path');
const {
  createUploadManagement,
  createManagedSourceResolver,
  createManagedFileRetrieval,
  composeManagedFileMaintenance,
  bindManagedContextSources,
  MANAGED_SOURCE_FILE_FIELDS,
  createUploadRuntime,
  createUploadLiveHub,
  createUploadHttpRouter,
  createIntakeControlHandlers,
  startIntakeControlService,
  createUploadWorkers,
  createManagedUploadCleanup,
  createHttpUploadSecurityPort,
  createUnixDocumentPort,
  createManagedS3Storage,
  getManagedS3Provider,
  createUploadMetrics,
  createManagedS3Client,
  validateEmailCodeBearer,
  validateBrowserBearer,
  guestUploadTransitionEnabled,
  getEmailCodeSettings,
  UploadManagementError,
  getRemainingShutdownMs,
} = require('@librechat/api');
const {
  createUploadManagementRepository,
  createFileRetrievalOperationOwner,
  runAsSystem,
  logger,
} = require('@librechat/data-schemas');

const { createUploadTicketIssuer, managedIntakeControlConfig } = require('./UploadIntake');

let current;
let admissionsClosedBy;
let initialization = 'unstarted';
/** The actual composition inherits closure before acquiring its first dispatching service. */
const uploadMaintenance = Object.freeze({
  readStorageProvider() {
    if (current) return current.readStorageProvider();
    if (initialization === 'disabled') return { state: 'disabled' };
    return { state: initialization === 'unstarted' ? 'uninitialized' : 'unavailable' };
  },
  pauseAdmissions(requestId) {
    if (!requestId || (admissionsClosedBy && admissionsClosedBy !== requestId)) return false;
    admissionsClosedBy = requestId;
    return current ? current.maintenance.pauseAdmissions(requestId) : true;
  },
  resumeAdmissions(requestId) {
    if (admissionsClosedBy !== requestId || !['ready', 'disabled'].includes(initialization))
      return false;
    if (current && !current.maintenance.resumeAdmissions(requestId)) return false;
    admissionsClosedBy = undefined;
    return true;
  },
  async getMaintenanceCensus(requestId) {
    if (current) return current.maintenance.getMaintenanceCensus(requestId);
    return {
      admissionClosed: !!admissionsClosedBy && admissionsClosedBy === requestId,
      queuedContinuations: 0,
      pendingWrites: initialization === 'initializing' ? 1 : 0,
      // Only the actual disabled acquisition branch knows that no runtime was constructed.
      complete: initialization === 'disabled',
    };
  },
});
const getUploadRuntime = () => current;
/** The server composition, never request metadata, selects managed source access. */
const getManagedContextSources = (req) =>
  bindManagedContextSources(
    req,
    current?.sources,
    process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED === 'true',
  );

/** Operator-owned mTLS identity; no request can choose hosts, credentials or policy. */
async function managedSecurityClient() {
  const endpoint = process.env.UPLOAD_SECURITY_ENDPOINT;
  const policySha256 = process.env.UPLOAD_SECURITY_POLICY_SHA256;
  const allowedHosts = (process.env.UPLOAD_SECURITY_ALLOWED_HOSTS ?? '').split(',').filter(Boolean);
  const paths = ['CA', 'CERT', 'KEY'].map(
    (name) => process.env[`UPLOAD_SECURITY_TLS_${name}_FILE`],
  );
  if (
    !endpoint ||
    !/^[a-f0-9]{64}$/.test(policySha256 ?? '') ||
    !allowedHosts.length ||
    paths.some((value) => !value || !isAbsolute(value))
  ) {
    throw new Error('Upload security configuration unavailable');
  }
  try {
    const [ca, cert, key] = await Promise.all(
      paths.map(async (file) => {
        const value = await readFile(file);
        if (value.length < 1 || value.length > 65536) throw new Error('Invalid TLS material');
        return value;
      }),
    );
    return createHttpUploadSecurityPort({
      endpoint,
      allowedHosts,
      policySha256,
      tls: { ca, cert, key },
    });
  } catch {
    throw new Error('Upload security configuration unavailable');
  }
}

/** Bind after the generation store is configured; File remains the only quota owner. */
function configureUploadSourceReplay({ manager, models, metrics }) {
  if (
    typeof manager?.configureSourceReplay !== 'function' ||
    typeof models?.reserveFileSourceCopies !== 'function' ||
    typeof models?.releaseFileSourceCopies !== 'function'
  ) {
    throw new Error('Document replay accounting unavailable');
  }
  manager.configureSourceReplay({
    quota: {
      reserveFileSourceCopies: (owner, reservation) =>
        runAsSystem(() => models.reserveFileSourceCopies(owner, reservation)),
      releaseFileSourceCopies: (owner, reservation) =>
        runAsSystem(() => models.releaseFileSourceCopies(owner, reservation)),
    },
    observe: (observation) => metrics.observeSourceReplay(observation),
  });
}

/** Existing Upload composition shares the managed storage construction owner. */
const managedStorageClient = () => createManagedS3Client(process.env);

/** Revalidate the current durable grant without extending foreground idle lifetime. */
function uploadPrincipal(repository) {
  return async (request) => {
    const authorization = request.headers.authorization;
    if (
      typeof authorization !== 'string' ||
      authorization.length > 16384 ||
      !/^Bearer [A-Za-z0-9._-]+$/.test(authorization)
    ) {
      throw new UploadManagementError('unauthorized');
    }
    try {
      const payload = jwt.verify(authorization.slice(7), process.env.JWT_SECRET, {
        algorithms: ['HS256'],
      });
      const guest = payload?.provider === 'browser';
      const identity = await runAsSystem(() =>
        guest
          ? validateBrowserBearer(payload, request, repository)
          : validateEmailCodeBearer(payload, repository),
      );
      if (!identity) throw new Error('unauthorized');
      return {
        tenantId: identity.grant.tenantId,
        userId: identity.grant.userId,
        authentication: guest ? 'guest' : 'verified-email',
      };
    } catch {
      throw new UploadManagementError('unauthorized');
    }
  };
}

/** Existing File owner supplies only live, personal references; storage keys never leave it. */
function attachmentProjection(models) {
  return async (principal, operations) => {
    const ids = operations.flatMap((operation) => (operation.fileId ? [operation.fileId] : []));
    if (!ids.length) return new Map();
    const files = await runAsSystem(() =>
      models.getFiles(
        {
          file_id: { $in: ids },
          tenantId: principal.tenantId,
          user: principal.userId,
          retentionAcceptedAt: { $exists: true },
          embedded: true,
        },
        null,
        'file_id filename filepath type source bytes embedded llmDeliveryPath',
        100,
      ),
    );
    return new Map(
      (files ?? []).map((file) => [
        file.file_id,
        {
          file_id: file.file_id,
          filename: file.filename,
          filepath: `/api/files/managed/${encodeURIComponent(file.file_id)}`,
          type: file.type,
          source: file.source,
          bytes: file.bytes,
          embedded: file.embedded,
          llmDeliveryPath: file.llmDeliveryPath,
        },
      ]),
    );
  };
}

/** Thin LibreChat adapter. Upload policy remains behind the component's documented ports. */
async function createUploadComposition({
  repository,
  models,
  registry,
  worker,
  platform,
  storage,
  documents,
  security,
  stagingRoot,
  allowedOrigins,
  trustedFile,
  retrievalOperations,
  signal,
  principal = uploadPrincipal(models),
}) {
  signal?.throwIfAborted();
  if (
    !worker?.hostId ||
    !worker.instanceId ||
    !platform?.resources ||
    !platform.snapshots ||
    typeof platform.hardGuards !== 'function' ||
    typeof security?.prepare !== 'function' ||
    typeof security.inspect !== 'function' ||
    typeof security.cancel !== 'function'
  )
    throw new Error('Invalid upload composition');
  let pausedBy;
  let closed = false;
  const fileOperations = new Set();
  function runFileOperation(work) {
    if (closed || pausedBy) return Promise.reject(new UploadManagementError('admission_paused'));
    // Register before dispatch, and release on the original's settlement, never HTTP close.
    const original = Promise.resolve().then(work);
    fileOperations.add(original);
    void original.then(
      () => fileOperations.delete(original),
      () => fileOperations.delete(original),
    );
    return original;
  }
  const metrics = createUploadMetrics(registry, [worker.hostId], {
    slot: worker.hostId,
    snapshot: () => security.dispatchObservation?.() ?? null,
  }).bind(worker.hostId);
  const tenant = getEmailCodeSettings().tenantId;
  const management = createUploadManagement({
    repository,
    identity: {
      authorize: async (owner, request) =>
        request.resourceType === 'upload' &&
        ['read', 'upload', 'change', 'remove'].includes(request.action) &&
        request.owner.scope.kind === 'personal' &&
        request.owner.ownerUserId === owner.userId &&
        request.owner.tenantId === owner.tenantId &&
        !!owner.userId &&
        ((owner.authentication === 'verified-email' && owner.tenantId === tenant) ||
          (guestUploadTransitionEnabled() &&
            owner.authentication === 'guest' &&
            owner.tenantId === null)),
    },
    resources: platform.resources,
    telemetry: {
      transition: metrics.transition,
      retry: metrics.retry,
      rejectQuota: metrics.rejectQuota,
    },
  });
  const processing = {
    management,
    storage,
    documents,
    worker,
    stagingRoot,
    observe: (observation) => metrics.observeDuration(observation),
  };
  const workers = createUploadWorkers({
    processing,
    settlement: { repository, security },
    runAsSystem,
    onError: () => logger.warn('[Uploads] processing unavailable'),
  });
  const cleanup = createManagedUploadCleanup({
    repository,
    storage,
    actor: workers.settlement,
  });
  const live = createUploadLiveHub({
    repository,
    principal,
    tenantId: tenant,
    includeGuests: guestUploadTransitionEnabled(),
    admissionStatus: () => controller.status().admissionsPaused,
    observe({ connections, outcome }) {
      metrics.liveConnections(connections);
      if (['changed', 'reset'].includes(outcome)) metrics.event('update');
      if (outcome === 'heartbeat' || outcome === 'closed') metrics.event(outcome);
    },
  });
  const controller = createUploadRuntime({
    repository,
    ownerId: worker.instanceId,
    expected: platform.expected,
    snapshots: platform.snapshots,
    hardGuards: platform.hardGuards,
    observe(event) {
      if (event.kind === 'metrics') metrics.observeSnapshot(event.snapshot);
      if (event.kind === 'control') metrics.observeControl(event.decision);
      if (event.kind === 'unavailable') metrics.observeAdmissionUnavailable();
    },
  });
  platform.bindMetrics?.(metrics);
  const intakeHandlers = createIntakeControlHandlers({
    observeSecurityDispatch: (observation) => metrics.observeSecurityDispatch(observation),
    repository,
    identityRepository: models,
    management,
    resources: platform.resources,
    storage,
    attempts: workers.attempts,
    worker,
  });
  const authority = { principal, allowedOrigins };
  const router = createUploadHttpRouter({
    ...authority,
    runFileOperation,
    management,
    live,
    status: controller.status,
    projectAttachments: attachmentProjection(models),
    issueIntake: createUploadTicketIssuer({ repository, identityRepository: models, management }),
  });
  const extractionPolicySha256 = trustedFile?.extractionPolicySha256;
  const sources = createManagedSourceResolver({
    allowedOrigins,
    principal,
    operation: (user, id) => management.get(user, id),
    file: (user, id, text) =>
      runAsSystem(() =>
        models.getFiles(
          { tenantId: user.tenantId, user: user.userId, file_id: id, uploadOperationId: id },
          null,
          `${MANAGED_SOURCE_FILE_FIELDS}${text ? ' text textFormat +documentStructure +securityApproval' : ''}`,
          1,
        ),
      ).then((files) => files?.[0] ?? null),
    original: (user, id) => runAsSystem(() => repository.cleanupForFile(user, id)),
    policySha256: () => security.policySha256,
    extractionPolicySha256: () => extractionPolicySha256,
    storage,
  });
  const retrieval = await createManagedFileRetrieval({
    trustedFile,
    sources,
    operations: retrievalOperations,
    runAsSystem,
    signal,
  });
  const workMaintenance = composeManagedFileMaintenance(workers.maintenance, retrieval);
  const maintenance = {
    pauseAdmissions(requestId) {
      if (!requestId || (pausedBy && pausedBy !== requestId)) return false;
      pausedBy = requestId;
      return workMaintenance.pauseAdmissions(requestId);
    },
    resumeAdmissions(requestId) {
      if (closed || pausedBy !== requestId || !workMaintenance.resumeAdmissions(requestId))
        return false;
      pausedBy = undefined;
      return true;
    },
    async getMaintenanceCensus(requestId) {
      const census = await workMaintenance.getMaintenanceCensus(requestId);
      return {
        ...census,
        admissionClosed: !!pausedBy && pausedBy === requestId && census.admissionClosed,
        pendingWrites: census.pendingWrites + fileOperations.size,
      };
    },
  };
  let starting;
  return {
    sources,
    retrieval,
    management,
    repository,
    runFileOperation,
    fileReads: repository.fileReads,
    fileReadWorker: Object.freeze({ ...worker }),
    cleanup,
    storage,
    principal,
    router,
    intakeHandlers: { ...intakeHandlers, ...(retrieval ? { lookup: retrieval.lookup } : {}) },
    allowedOrigins: Object.freeze([...allowedOrigins]),
    maintenance,
    configureSourceReplay(manager) {
      configureUploadSourceReplay({ manager, models, metrics });
    },
    start() {
      if (!starting)
        starting = Promise.resolve().then(async () => {
          signal?.throwIfAborted();
          await platform.start?.();
          signal?.throwIfAborted();
          controller.start();
          workers.start();
        });
      return starting;
    },
    async close(signal = AbortSignal.timeout(Math.max(1, getRemainingShutdownMs() ?? 30_000))) {
      closed = true;
      live.close();
      let abort;
      const settled = await Promise.allSettled([
        workers.close(signal),
        controller.stop(),
        retrieval?.close(signal),
        (async () => {
          try {
            const interrupted = new Promise((_, reject) => {
              abort = () => reject(new Error('Upload original drain interrupted'));
              signal.addEventListener('abort', abort, { once: true });
            });
            signal.throwIfAborted();
            await Promise.race([Promise.allSettled([...fileOperations]), interrupted]);
          } finally {
            if (abort) signal.removeEventListener('abort', abort);
          }
        })(),
      ]);
      await platform.close?.();
      if (settled.some((result) => result.status === 'rejected') || !settled[0].value?.complete)
        throw new Error('Upload shutdown has unresolved work');
    },
  };
}

/** Called once after database/storage initialization. Disabled means no adapter, timer or watch. */
async function initializeUploads({
  registry,
  identity,
  trustedFile,
  recordOriginalPublication,
  signal,
  onFailure,
}) {
  if (process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED !== 'true') {
    initialization = 'disabled';
    return undefined;
  }
  signal?.throwIfAborted();
  if (current) return current;
  initialization = 'initializing';
  if (
    !identity ||
    !/^[a-f0-9]{40}$/.test(identity.source) ||
    identity.source !== process.env.BUILD_COMMIT ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(identity.podUid) ||
    identity.podUid !== process.env.POD_UID ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      identity.incarnation,
    )
  )
    throw new Error('Upload process identity unavailable');
  const intakeConfig = await managedIntakeControlConfig();
  signal?.throwIfAborted();
  const security = await managedSecurityClient();
  signal?.throwIfAborted();
  const client = managedStorageClient();
  const mongoose = require('mongoose');
  const models = require('~/models');
  const { createUploadPlatform } = require('./UploadPlatform');
  const worker = { hostId: process.env.POD_NODE_NAME, instanceId: identity.incarnation };
  const stagingRoot = '/var/lib/cortex/uploads/staging';
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  signal?.throwIfAborted();
  const directory = await lstat(stagingRoot);
  signal?.throwIfAborted();
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid() ||
    (directory.mode & 0o077) !== 0
  ) {
    throw new Error('Unsafe upload staging directory');
  }
  const repository = createUploadManagementRepository(mongoose, {
    securityPolicySha256: security.policySha256,
    extractionPolicySha256: trustedFile?.extractionPolicySha256,
    recordOriginalPublication,
  });
  // Initialization never attests an empty store or enables an unreconciled authority.
  await runAsSystem(() => repository.initialize());
  signal?.throwIfAborted();
  const platform = await createUploadPlatform({ repository, worker, stagingRoot });
  const storage = createManagedS3Storage({
    client,
    bucket: process.env.AWS_BUCKET_NAME,
    urlForKey: async (key) => {
      const match = /\/([a-zA-Z0-9-]+)\.[1-9][0-9]*__original$/.exec(key);
      if (!match) throw new Error('Invalid managed original locator');
      return `/api/files/managed/${match[1]}`;
    },
    observeBackend: (observation) => platform.metrics?.observeBackend(observation),
    observeBackendService: (observation) => platform.metrics?.observeBackendService(observation),
  });
  const documents = createUnixDocumentPort({
    stagingRoot,
    socketPath: '/var/run/cortex-upload-parser/parser.sock',
  });
  const origin = new URL(process.env.DOMAIN_CLIENT).origin;
  const composition = await createUploadComposition({
    repository,
    models,
    registry,
    worker,
    platform,
    storage,
    documents,
    security,
    stagingRoot,
    allowedOrigins: [origin],
    trustedFile,
    signal,
    retrievalOperations: (policySnapshot) =>
      createFileRetrievalOperationOwner(mongoose, { policySnapshot }),
  });
  try {
    signal?.throwIfAborted();
    if (admissionsClosedBy && !composition.maintenance.pauseAdmissions(admissionsClosedBy))
      throw new Error('Upload startup admission closure unconfirmed');
  } catch (error) {
    initialization = 'failed';
    try {
      onFailure?.(error);
    } catch {
      /* Notify before original cleanup without skipping it. */
    }
    try {
      await composition.close(AbortSignal.timeout(Math.max(1, getRemainingShutdownMs() ?? 30_000)));
    } catch {
      /* Preserve the first startup failure after the original cleanup settles. */
    }
    throw error;
  }
  let intakeControl;
  let starting;
  let closing;
  let startingPending = false;
  let closingPending = false;
  let intakePausedBy = admissionsClosedBy;
  const maintenance = {
    pauseAdmissions(requestId) {
      if (!requestId || (intakePausedBy && intakePausedBy !== requestId)) return false;
      intakePausedBy = requestId;
      const compositionClosed = composition.maintenance.pauseAdmissions(requestId);
      const intakeClosed = intakeControl?.maintenance.pauseAdmissions(requestId) ?? true;
      return compositionClosed && intakeClosed;
    },
    resumeAdmissions(requestId) {
      if (closing || intakePausedBy !== requestId) return false;
      if (intakeControl && !intakeControl.maintenance.resumeAdmissions(requestId)) return false;
      if (!composition.maintenance.resumeAdmissions(requestId)) {
        intakeControl?.maintenance.pauseAdmissions(requestId);
        return false;
      }
      intakePausedBy = undefined;
      return true;
    },
    async getMaintenanceCensus(requestId) {
      const [compositionCensus, intakeCensus] = await Promise.all([
        composition.maintenance.getMaintenanceCensus(requestId),
        intakeControl?.maintenance.getMaintenanceCensus(requestId),
      ]);
      return {
        admissionClosed:
          compositionCensus.admissionClosed &&
          !!intakePausedBy &&
          intakePausedBy === requestId &&
          (intakeCensus?.admissionClosed ?? true),
        queuedContinuations:
          compositionCensus.queuedContinuations + (intakeCensus?.queuedContinuations ?? 0),
        pendingWrites:
          compositionCensus.pendingWrites +
          (intakeCensus?.pendingWrites ?? 0) +
          Number(startingPending) +
          Number(closingPending),
        complete: compositionCensus.complete && (intakeCensus?.complete ?? true),
      };
    },
  };
  current = {
    ...composition,
    maintenance,
    readStorageProvider: () =>
      initialization !== 'ready'
        ? { state: 'unavailable' }
        : getManagedS3Provider(storage, platform.readStorageBackend()),
    start() {
      if (intakePausedBy || closing)
        return Promise.reject(new Error('Upload startup admission is closed'));
      if (starting) return starting;
      startingPending = true;
      // Retain this original before native listener or runtime dispatch starts.
      starting = Promise.resolve()
        .then(async () => {
          signal?.throwIfAborted();
          try {
            intakeControl = await startIntakeControlService({
              ...intakeConfig,
              handlers: composition.intakeHandlers,
            });
            if (intakePausedBy && !intakeControl.maintenance.pauseAdmissions(intakePausedBy))
              throw new Error('Upload intake admission closure unconfirmed');
            signal?.throwIfAborted();
            if (closing) throw new Error('Upload shutdown precedes runtime dispatch');
            await composition.start();
          } catch (error) {
            try {
              onFailure?.(error);
            } catch {
              /* Original failure still owns cleanup. */
            }
            throw error;
          }
        })
        .finally(() => {
          startingPending = false;
        });
      return starting;
    },
    close(signal) {
      if (closing) return closing;
      initialization = 'closing';
      const paused = maintenance.pauseAdmissions(intakePausedBy ?? 'shutdown');
      closingPending = true;
      // A late listener remains this owner's original: stop dispatch, join it, then close it.
      closing = Promise.resolve()
        .then(async () => {
          await starting?.catch(() => undefined);
          let intakeResult;
          const failures = [];
          try {
            intakeResult = await intakeControl?.close(signal);
          } catch (error) {
            failures.push(error);
          }
          try {
            await composition.close(signal);
          } catch (error) {
            failures.push(error);
          }
          if (!paused || (intakeResult && !intakeResult.complete) || failures.length)
            throw new Error('Upload shutdown has unresolved original work');
        })
        .finally(() => {
          closingPending = false;
        });
      return closing;
    },
  };
  initialization = 'ready';
  return current;
}

module.exports = {
  uploadMaintenance,
  getUploadRuntime,
  getManagedContextSources,
  initializeUploads,
  createUploadComposition,
  uploadPrincipal,
  attachmentProjection,
  managedStorageClient,
  managedSecurityClient,
  configureUploadSourceReplay,
};
