import { createServer } from 'node:http';
import { setTimeout, clearTimeout } from 'node:timers';
import { timingSafeEqual, createHash } from 'node:crypto';
import type { GenerationAdmissionMethods } from '@librechat/data-schemas';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { RequestHandler } from 'express';
import type {
  ExternalApplicationWorkCensus,
  ApplicationWorkPort,
  GenerationMaintenanceCensus,
  MaintenanceOwnerSample,
} from './maintenanceCensus';
import type { MaintenanceIdentity } from './identity';
import {
  MAINTENANCE_COUNTERS as counters,
  captureFileDomainOwners,
  aggregateMaintenanceOwners,
  composeMaintenanceCensus,
} from './maintenanceCensus';
import { createMaintenanceIdentity } from './identity';

export type { MaintenanceIdentity } from './identity';
export type {
  ApplicationWorkCensus,
  ExternalApplicationWorkCensus,
  ApplicationWorkPort,
  GenerationMaintenanceCensus,
} from './maintenanceCensus';

export interface GenerationMaintenancePort {
  closeGenerationAdmission(requestId: string): boolean;
  reopenGenerationAdmission(requestId: string): boolean;
  getGenerationAdmissionCensus(): Promise<GenerationMaintenanceCensus>;
  getGenerationRuntimeHealth(): Promise<boolean>;
}
export interface MaintenanceDependencies {
  /** The native web entry selects this before dispatch; this is no File/native readiness grant. */
  startupAdmission?: 'closed';
  env: Record<string, string | undefined>;
  requiredSharedState: boolean;
  generation: GenerationMaintenancePort;
  workOwners?: Readonly<Record<string, ApplicationWorkPort>>;
  /** Existing owner keys; [] explicitly declares no qualified File-domain coverage. */
  fileDomainOwners: readonly string[];
  unqualifiedOwners?: readonly string[];
  startupReady(): boolean;
  probeDatabase(): Promise<boolean>;
  probeSharedState(): Promise<boolean>;
}
export interface WorkloadMaintenanceDependencies {
  env: Record<string, string | undefined>;
  identity: MaintenanceIdentity;
  workOwners: Readonly<Record<string, ApplicationWorkPort>>;
  fileDomainOwners: readonly string[];
  startupReady(): boolean;
}
type LifecycleDependencies =
  | (MaintenanceDependencies & { kind: 'application'; identity: MaintenanceIdentity })
  | (WorkloadMaintenanceDependencies & { kind: 'workload' });
/** Local File-affecting work under the enclosing identity/request/revision, never a native hold. */
export interface FileDomainStatus {
  known: boolean;
  census: GenerationMaintenanceCensus | null;
}
export interface MaintenanceStatus {
  identity: MaintenanceIdentity;
  requestId: string | null;
  revision: number;
  phase: 'running' | 'quiescing' | 'drained';
  known: boolean;
  census: GenerationMaintenanceCensus | null;
  blockingReasons: string[];
  fileDomain: FileDomainStatus;
}
export interface AppMaintenance {
  identity: MaintenanceIdentity;
  externalCensus(): Promise<ExternalApplicationWorkCensus>;
  ready(): Promise<boolean>;
  status(): Promise<MaintenanceStatus>;
  operation(action: 'begin' | 'cancel', body: unknown): number;
  /** Retain the original startup continuation until this incarnation's exact startup cancel. */
  waitForStartupRelease(signal: AbortSignal): Promise<void>;
  handler(req: IncomingMessage, res: ServerResponse): void;
  readinessHandler: RequestHandler;
  admissionMiddleware: RequestHandler;
  mutationMiddleware: RequestHandler;
  listen(): Promise<void>;
  close(): Promise<void>;
}
const loopback = (address?: string) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '');
const hash = (value: string) => createHash('sha256').update(value).digest();
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));

/** Bounds observation latency without treating a timed-out read as success. */
async function observe<T>(read: () => Promise<T>): Promise<T | undefined> {
  let cancelTimer: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), 2000);
        cancelTimer = () => clearTimeout(timer);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    cancelTimer?.();
  }
}
function reply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function readRequest(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type'] !== 'application/json') {
    throw new Error('INVALID_REQUEST');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 4096) {
      throw new Error('INVALID_REQUEST');
    }
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createAppMaintenance(deps: MaintenanceDependencies): AppMaintenance {
  return createMaintenanceController({
    ...deps,
    kind: 'application',
    identity: createMaintenanceIdentity(
      deps.env,
      deps.env.LIBRECHAT_MAINTENANCE_TOKEN !== undefined || deps.requiredSharedState,
    ),
  });
}

/** Explicitly generation-free services reuse the native controller and their actual work owners. */
export function createWorkloadMaintenance(deps: WorkloadMaintenanceDependencies): AppMaintenance {
  const supplied = deps.identity;
  if (
    !object(supplied) ||
    !exactKeys(supplied, ['podUid', 'source', 'incarnation']) ||
    typeof supplied.podUid !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(supplied.podUid) ||
    supplied.podUid !== deps.env.POD_UID ||
    typeof supplied.source !== 'string' ||
    !/^[a-f0-9]{40}$/.test(supplied.source) ||
    supplied.source !== deps.env.BUILD_COMMIT ||
    typeof supplied.incarnation !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      supplied.incarnation,
    ) ||
    deps.env.LIBRECHAT_MAINTENANCE_TOKEN === undefined ||
    typeof deps.startupReady !== 'function' ||
    !object(deps.workOwners) ||
    !Object.keys(deps.workOwners).length ||
    Object.entries(deps.workOwners).some(
      ([name, owner]) =>
        !name ||
        !owner ||
        typeof owner.pauseAdmissions !== 'function' ||
        typeof owner.resumeAdmissions !== 'function' ||
        typeof owner.getMaintenanceCensus !== 'function',
    )
  ) {
    throw new Error('Invalid workload maintenance configuration');
  }
  const identity = Object.freeze({
    podUid: supplied.podUid,
    source: supplied.source,
    incarnation: supplied.incarnation,
  });
  return createMaintenanceController({ ...deps, kind: 'workload', identity });
}

/** One private lifecycle/HTTP/authentication owner; provider records remain with actual owners. */
function createMaintenanceController(deps: LifecycleDependencies): AppMaintenance {
  const token = deps.env.LIBRECHAT_MAINTENANCE_TOKEN;
  const controlEnabled = token !== undefined;
  const port = Number(deps.env.LIBRECHAT_MAINTENANCE_PORT ?? '3091');
  const identity = deps.identity;
  if (
    controlEnabled &&
    (!token ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(token) ||
      !Number.isSafeInteger(port) ||
      port < 1 ||
      port > 65535)
  ) {
    throw new Error('Invalid private maintenance configuration');
  }
  const tokenHash = hash(token ?? '');
  const startupId =
    deps.kind === 'application' && deps.startupAdmission === 'closed'
      ? `startup_${identity.incarnation}`
      : undefined;
  if (startupId && !controlEnabled) throw new Error('Closed startup requires private maintenance');
  let releaseStartup: (() => void) | undefined;
  const startupRelease = startupId
    ? new Promise<void>((resolve) => {
        releaseStartup = resolve;
      })
    : undefined;
  let requestId: string | null = null;
  let revision = 0;
  let uncertain = false;
  let cancelled: { requestId: string; revision: number } | undefined;
  let listener: Server | undefined;
  const owners = Object.entries(deps.workOwners ?? {});
  const fileDomainOwners = captureFileDomainOwners(deps.fileDomainOwners, owners);
  const unqualifiedOwners =
    deps.kind === 'application'
      ? [...(deps.unqualifiedOwners ?? ['application coverage undeclared'])]
      : [];
  const coverageDeclared = deps.workOwners !== undefined;

  function changeOwners(action: 'pauseAdmissions' | 'resumeAdmissions', id: string): boolean {
    let successful = true;
    for (const [, owner] of owners) {
      try {
        if (owner[action](id) !== true) successful = false;
      } catch {
        successful = false;
      }
    }
    if (deps.kind === 'application') {
      try {
        const change =
          action === 'pauseAdmissions'
            ? deps.generation.closeGenerationAdmission
            : deps.generation.reopenGenerationAdmission;
        if (change.call(deps.generation, id) !== true) successful = false;
      } catch {
        successful = false;
      }
    }
    return successful;
  }

  function sampleOwners(id: string | null): Promise<MaintenanceOwnerSample[]> {
    return Promise.all(
      owners.map(
        async ([name, owner]) =>
          [name, await observe(() => owner.getMaintenanceCensus(id))] as const,
      ),
    );
  }

  async function externalCensus(): Promise<ExternalApplicationWorkCensus> {
    const sampledRevision = revision;
    const sampledRequest = requestId;
    const samples = await sampleOwners(sampledRequest);
    return aggregateMaintenanceOwners(
      samples,
      sampledRequest !== null,
      coverageDeclared &&
        unqualifiedOwners.length === 0 &&
        !uncertain &&
        sampledRevision === revision &&
        sampledRequest === requestId,
    );
  }

  async function ready(): Promise<boolean> {
    if (
      (await observe(async () => deps.startupReady())) !== true ||
      requestId !== null ||
      uncertain
    ) {
      return false;
    }
    // Busy or incomplete work is a drain concern, not a workload liveness probe.
    if (deps.kind === 'workload' || (!controlEnabled && !deps.requiredSharedState)) {
      return true;
    }
    const sampledRevision = revision;
    const result = await observe(async () => {
      const [database, shared, owner] = await Promise.all([
        deps.probeDatabase(),
        deps.probeSharedState(),
        deps.generation.getGenerationRuntimeHealth(),
      ]);
      return database === true && shared === true && owner === true;
    });
    const started = (await observe(async () => deps.startupReady())) === true;
    return (
      result === true && started && sampledRevision === revision && requestId === null && !uncertain
    );
  }
  async function status(): Promise<MaintenanceStatus> {
    const sampledRevision = revision;
    const sampledRequest = requestId;
    const closed = sampledRequest !== null;
    const [generation, samples] = await Promise.all([
      deps.kind === 'application'
        ? observe(() => deps.generation.getGenerationAdmissionCensus())
        : Promise.resolve({
            admissionClosed: closed,
            initializing: 0,
            providerExecutions: 0,
            queuedContinuations: 0,
            pendingWrites: 0,
            activeStreams: 0,
            unresolved: 0,
            complete: true,
          }),
      sampleOwners(sampledRequest),
    ]);
    const current = sampledRevision === revision && sampledRequest === requestId && !uncertain;
    const census = composeMaintenanceCensus(
      generation,
      aggregateMaintenanceOwners(
        samples,
        closed,
        coverageDeclared && unqualifiedOwners.length === 0,
      ),
      closed,
      current,
    );
    const fileCensus = composeMaintenanceCensus(
      generation,
      aggregateMaintenanceOwners(samples, closed, fileDomainOwners.size > 0, fileDomainOwners),
      closed,
      current,
    );
    const known = census !== null;
    const drained = closed && census !== null && counters.every((key) => census[key] === 0);
    let phase: MaintenanceStatus['phase'] = requestId !== null ? 'quiescing' : 'running';
    if (drained) phase = 'drained';
    return {
      identity,
      requestId,
      revision,
      phase,
      known,
      census,
      blockingReasons: [
        ...unqualifiedOwners,
        ...(!coverageDeclared ? ['application coverage undeclared'] : []),
        ...(!known ? ['census incomplete or admission uncertain'] : []),
      ],
      fileDomain: { known: fileCensus !== null, census: fileCensus },
    };
  }
  function operation(action: 'begin' | 'cancel', body: unknown): number {
    if (
      !object(body) ||
      !exactKeys(body, ['requestId', 'identity', 'expectedRevision']) ||
      !Number.isSafeInteger(body.expectedRevision) ||
      typeof body.requestId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(body.requestId) ||
      !object(body.identity) ||
      !exactKeys(body.identity, ['podUid', 'source', 'incarnation']) ||
      Object.entries(identity).some(
        ([key, value]) => body.identity && object(body.identity) && body.identity[key] !== value,
      )
    ) {
      return 400;
    }
    if (action === 'begin') {
      if (requestId !== null && requestId !== body.requestId) {
        return 409;
      }
      if (requestId === body.requestId) {
        return uncertain ? 503 : 200;
      }
      if (body.expectedRevision !== revision) {
        return 409;
      }
      // Fence the local admission gate before invoking the synchronous owner and before any await.
      requestId = body.requestId;
      revision++;
      uncertain = !changeOwners('pauseAdmissions', requestId);
      return uncertain ? 503 : 200;
    }
    if (
      requestId === null &&
      cancelled?.requestId === body.requestId &&
      cancelled.revision === revision &&
      body.expectedRevision === revision - 1
    ) {
      return 200;
    }
    if (requestId !== body.requestId || body.expectedRevision !== revision || uncertain) {
      return 409;
    }
    if (!changeOwners('resumeAdmissions', requestId)) {
      uncertain = true;
      return 503;
    }
    cancelled = { requestId, revision: revision + 1 };
    const releasesStartup = requestId === startupId && revision === 1;
    requestId = null;
    revision++;
    if (releasesStartup) releaseStartup?.();
    return 200;
  }
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      if (!controlEnabled || !loopback(req.socket.remoteAddress)) {
        reply(res, 403, { code: 'FORBIDDEN' });
        return;
      }
      if (req.url === '/livez' && req.method === 'GET') {
        reply(res, 200, { live: true });
        return;
      }
      if (req.url === '/readyz' && req.method === 'GET') {
        const value = await ready();
        reply(res, value ? 200 : 503, { ready: value });
        return;
      }
      const authorization = req.headers.authorization;
      if (
        req.headers.origin ||
        req.headers.cookie ||
        req.headers['sec-fetch-site'] ||
        typeof authorization !== 'string' ||
        !authorization.startsWith('Bearer ') ||
        authorization.length > 263 ||
        !timingSafeEqual(hash(authorization.slice(7)), tokenHash)
      ) {
        reply(res, 403, { code: 'FORBIDDEN' });
        return;
      }
      if (req.url === '/status' && req.method === 'GET') {
        reply(res, 200, await status());
        return;
      }
      if (req.method !== 'POST' || (req.url !== '/begin' && req.url !== '/cancel')) {
        reply(res, 404, { code: 'NOT_FOUND' });
        return;
      }
      const body = await observe(() => readRequest(req));
      const code = operation(req.url === '/begin' ? 'begin' : 'cancel', body);
      reply(
        res,
        code,
        code === 200
          ? await status()
          : { code: code === 400 ? 'INVALID_REQUEST' : 'OWNERSHIP_UNCONFIRMED' },
      );
    })().catch(() => {
      if (!res.headersSent) {
        reply(res, 503, { code: 'UNAVAILABLE' });
      } else {
        res.end();
      }
    });
  };
  const readinessHandler: RequestHandler = (_req, res) => {
    void ready().then((value) => {
      res.status(value ? 200 : 503).send(value ? 'OK' : 'NOT_READY');
    });
  };
  const admissionMiddleware: RequestHandler = (req, res, next) => {
    if (req.method !== 'POST' || req.path === '/abort') {
      next();
      return;
    }
    void ready().then((value) => {
      if (value) {
        next();
        return;
      }
      res
        .set('Retry-After', '1')
        .status(503)
        .json({
          code: requestId !== null || uncertain ? 'APP_QUIESCING' : 'SERVER_NOT_READY',
          error: 'Generation admission is unavailable. Please retry shortly.',
        });
    });
  };
  const mutationMiddleware: RequestHandler = (req, res, next) => {
    if (
      (requestId === null && !uncertain) ||
      ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ||
      (req.method === 'POST' && req.path === '/agents/chat/abort')
    ) {
      next();
      return;
    }
    res.set('Retry-After', '1').status(503).json({
      code: 'APP_QUIESCING',
      error: 'Application admission is closed for maintenance.',
    });
  };
  if (
    startupId &&
    operation('begin', { requestId: startupId, identity, expectedRevision: 0 }) !== 200
  )
    throw new Error('Application startup hold unconfirmed');
  return {
    identity,
    externalCensus,
    ready,
    status,
    operation,
    async waitForStartupRelease(signal) {
      if (!startupRelease) throw new Error('Application has no owned startup hold');
      signal.throwIfAborted();
      let stop: (() => void) | undefined;
      try {
        await Promise.race([
          startupRelease,
          new Promise<never>((_resolve, reject) => {
            stop = () => reject(signal.reason ?? new Error('Application startup aborted'));
            signal.addEventListener('abort', stop, { once: true });
            if (signal.aborted) stop();
          }),
        ]);
        signal.throwIfAborted();
        if (requestId !== null || revision !== 2 || uncertain)
          throw new Error('Application startup admission changed before dispatch');
      } finally {
        if (stop) signal.removeEventListener('abort', stop);
      }
    },
    handler,
    readinessHandler,
    admissionMiddleware,
    mutationMiddleware,
    async listen(): Promise<void> {
      if (!controlEnabled || listener) {
        return;
      }
      const server = createServer(handler);
      server.requestTimeout = 5000;
      server.headersTimeout = 5000;
      server.maxHeadersCount = 20;
      listener = server;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
    },
    async close(): Promise<void> {
      if (!listener) {
        return;
      }
      const server = listener;
      listener = undefined;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** Actual command probes; subscriber health remains with the generation transport owner. */
export async function probeMaintenanceRedis(deps: {
  required: boolean;
  cache: { readonly isReady: boolean; ping(): Promise<unknown> } | null;
  commands: { readonly status: string; ping(): Promise<unknown> } | null;
}): Promise<boolean> {
  if (!deps.required) {
    return true;
  }
  if (!deps.cache?.isReady || deps.commands?.status !== 'ready') {
    return false;
  }
  const [cache, commands] = await Promise.all([deps.cache.ping(), deps.commands.ping()]);
  return cache === 'PONG' && commands === 'PONG';
}

export async function probeMaintenanceDatabase(database: {
  ping(): Promise<unknown>;
}): Promise<boolean> {
  const result = await database.ping();
  return object(result) && result.ok === 1;
}

/** Await durable index admission before configuring the existing generation owner. */
export async function initializeMaintenanceGeneration(deps: {
  required: boolean;
  methods: GenerationAdmissionMethods;
  identity: MaintenanceIdentity;
  configure(options: {
    required: boolean;
    methods?: GenerationAdmissionMethods;
    ownerInstanceId: string;
    processBootId: string;
  }): void;
}): Promise<void> {
  const methods: GenerationAdmissionMethods = {
    ...(deps.methods.beginGenerationPreparation && deps.methods.completeGenerationPreparation
      ? {
          beginGenerationPreparation: deps.methods.beginGenerationPreparation,
          completeGenerationPreparation: deps.methods.completeGenerationPreparation,
        }
      : {}),
    ensureGenerationAdmissionIndexes: deps.methods.ensureGenerationAdmissionIndexes,
    acquireGenerationAdmission: deps.methods.acquireGenerationAdmission,
    getGenerationAdmission: deps.methods.getGenerationAdmission,
    dispatchGenerationAdmission: deps.methods.dispatchGenerationAdmission,
    settleGenerationAdmission: deps.methods.settleGenerationAdmission,
    acquireGenerationAdmissionSuccessor: deps.methods.acquireGenerationAdmissionSuccessor,
    cancelUndispatchedGenerationAdmission: deps.methods.cancelUndispatchedGenerationAdmission,
    findGenerationAdmissionByEpoch: deps.methods.findGenerationAdmissionByEpoch,
    countUnsettledGenerationAdmissions: deps.methods.countUnsettledGenerationAdmissions,
    recoverGenerationAdmission: deps.methods.recoverGenerationAdmission,
    writeGenerationCheckpoint: deps.methods.writeGenerationCheckpoint,
  };
  if (deps.required) {
    if (Object.values(methods).some((method) => typeof method !== 'function')) {
      throw new Error('Generation admission methods unavailable');
    }
    await methods.ensureGenerationAdmissionIndexes();
  }
  deps.configure({
    required: deps.required,
    methods: deps.required ? methods : undefined,
    ownerInstanceId: deps.identity.podUid,
    processBootId: deps.identity.incarnation,
  });
}
