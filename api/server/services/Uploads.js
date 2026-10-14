const jwt = require('jsonwebtoken');
const { mkdir, lstat } = require('node:fs/promises');
const {
  createUploadManagement,
  createUploadRuntime,
  createUploadLiveHub,
  createUploadHttpRouter,
  createUploadBodyRouter,
  createRawUploadBodyHandler,
  createUploadWorkers,
  createManagedUploadCleanup,
  createUnixDocumentPort,
  createManagedS3Storage,
  createUploadMetrics,
  initializeS3,
  validateEmailCodeBearer,
  validateBrowserBearer,
  guestUploadTransitionEnabled,
  getEmailCodeSettings,
  UploadManagementError,
} = require('@librechat/api');
const {
  createUploadManagementRepository,
  runAsSystem,
  logger,
} = require('@librechat/data-schemas');

let current;
const getUploadRuntime = () => current;

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

/** Cortex uses a purpose-scoped native key, never the SDK's ambient credentials. */
function managedStorageClient() {
  let endpoint;
  try {
    endpoint = new URL(process.env.AWS_ENDPOINT_URL);
  } catch {
    /* checked below */
  }
  if (
    !process.env.AWS_REGION ||
    !process.env.AWS_BUCKET_NAME ||
    !process.env.AWS_ACCESS_KEY_ID ||
    !process.env.AWS_SECRET_ACCESS_KEY ||
    process.env.AWS_FORCE_PATH_STYLE !== 'true' ||
    !endpoint ||
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error('Managed storage configuration unavailable');
  }
  const client = initializeS3();
  if (!client) throw new Error('Managed original storage unavailable');
  return client;
}

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
  stagingRoot,
  allowedOrigins,
  principal = uploadPrincipal(models),
}) {
  if (
    !worker?.hostId ||
    !worker.instanceId ||
    !platform?.resources ||
    !platform.snapshots ||
    typeof platform.hardGuards !== 'function'
  )
    throw new Error('Invalid upload composition');
  const metrics = createUploadMetrics(registry, [worker.hostId]).bind(worker.hostId);
  const tenant = getEmailCodeSettings().tenantId;
  const management = createUploadManagement({
    repository,
    identity: {
      authorize: async (owner, scope) =>
        scope.kind === 'personal' &&
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
    runAsSystem,
    onError: () => logger.warn('[Uploads] processing unavailable'),
  });
  const cleanup = createManagedUploadCleanup({
    repository,
    storage,
    documents,
    attempts: workers.attempts,
    worker,
    stagingRoot,
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
  const body = createRawUploadBodyHandler({
    management,
    principal,
    storage,
    worker,
    stagingRoot,
    attempts: workers.attempts,
    claimBytes: management.claimWorkBytes,
    completeBytes: management.completeWorkBytes,
    observe(event) {
      if (event.kind === 'received') metrics.received(event.bytes);
      else if (event.kind === 'accepted') metrics.fileSize(event.bytes);
      // Storage service latency already has its own SDK observation.
      else if (event.stage !== 'storage')
        metrics.observeDuration({
          stage: event.stage,
          seconds: event.seconds,
          outcome: event.outcome,
        });
    },
  });
  const authority = { principal, allowedOrigins };
  const bodyRouter = createUploadBodyRouter({ ...authority, body });
  const router = createUploadHttpRouter({
    ...authority,
    management,
    live,
    status: controller.status,
    projectAttachments: attachmentProjection(models),
  });
  let started = false;
  return {
    management,
    repository,
    cleanup,
    storage,
    principal,
    router,
    bodyRouter,
    allowedOrigins: Object.freeze([...allowedOrigins]),
    maintenance: workers.maintenance,
    configureSourceReplay(manager) {
      configureUploadSourceReplay({ manager, models, metrics });
    },
    start() {
      if (started) return;
      started = true;
      platform.start?.();
      controller.start();
      workers.start();
    },
    async close(signal) {
      live.close();
      const [settled] = await Promise.all([workers.close(signal), controller.stop()]);
      await platform.close?.();
      if (!settled.complete) throw new Error('Upload shutdown has unresolved work');
    },
  };
}

/** Called once after database/storage initialization. Disabled means no adapter, timer or watch. */
async function initializeUploads({ registry }) {
  if (process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED !== 'true') return undefined;
  if (current) return current;
  const client = managedStorageClient();
  const mongoose = require('mongoose');
  const models = require('~/models');
  const { createUploadPlatform } = require('./UploadPlatform');
  const worker = { hostId: process.env.POD_NODE_NAME, instanceId: process.env.POD_UID };
  const stagingRoot = '/var/lib/cortex/uploads/staging';
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const directory = await lstat(stagingRoot);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid() ||
    (directory.mode & 0o077) !== 0
  ) {
    throw new Error('Unsafe upload staging directory');
  }
  const repository = createUploadManagementRepository(mongoose);
  // Initialization never attests an empty store or enables an unreconciled authority.
  await runAsSystem(() => repository.initialize());
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
  current = await createUploadComposition({
    repository,
    models,
    registry,
    worker,
    platform,
    storage,
    documents,
    stagingRoot,
    allowedOrigins: [origin],
  });
  return current;
}

module.exports = {
  getUploadRuntime,
  initializeUploads,
  createUploadComposition,
  uploadPrincipal,
  attachmentProjection,
  managedStorageClient,
  configureUploadSourceReplay,
};
