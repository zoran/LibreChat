import { createServer } from 'node:http';
import { setTimeout, clearTimeout } from 'node:timers';
import { timingSafeEqual, createHash } from 'node:crypto';
import type { GenerationAdmissionMethods } from '@librechat/data-schemas';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { RequestHandler } from 'express';
import type { MaintenanceIdentity } from './identity';
import { createMaintenanceIdentity } from './identity';

export type { MaintenanceIdentity } from './identity';

/** Existing application owners report their own admitted work; no provider registry here. */
export interface ApplicationWorkCensus {
  admissionClosed: boolean;
  queuedContinuations: number;
  pendingWrites: number;
  complete: boolean;
}
export type ExternalApplicationWorkCensus = Pick<
  ApplicationWorkCensus,
  'queuedContinuations' | 'pendingWrites' | 'complete'
>;
export interface ApplicationWorkPort {
  pauseAdmissions(requestId: string): boolean;
  resumeAdmissions(requestId: string): boolean;
  getMaintenanceCensus(requestId: string | null): Promise<ApplicationWorkCensus>;
}

/** The generation owner, not this composition, accounts for admitted work and persistence. */
export interface GenerationMaintenanceCensus {
  admissionClosed: boolean;
  initializing: number;
  providerExecutions: number;
  queuedContinuations: number;
  pendingWrites: number;
  activeStreams: number;
  unresolved: number;
  complete: boolean;
}
export interface GenerationMaintenancePort {
  closeGenerationAdmission(requestId: string): boolean;
  reopenGenerationAdmission(requestId: string): boolean;
  getGenerationAdmissionCensus(): Promise<GenerationMaintenanceCensus>;
  getGenerationRuntimeHealth(): Promise<boolean>;
}
export interface MaintenanceDependencies {
  env: Record<string, string | undefined>;
  requiredSharedState: boolean;
  generation: GenerationMaintenancePort;
  workOwners?: Readonly<Record<string, ApplicationWorkPort>>;
  unqualifiedOwners?: readonly string[];
  startupReady(): boolean;
  probeDatabase(): Promise<boolean>;
  probeSharedState(): Promise<boolean>;
}
export interface MaintenanceStatus {
  identity: MaintenanceIdentity;
  requestId: string | null;
  revision: number;
  phase: 'running' | 'quiescing' | 'drained';
  known: boolean;
  census: GenerationMaintenanceCensus | null;
  blockingReasons: string[];
}
export interface AppMaintenance {
  identity: MaintenanceIdentity;
  externalCensus(): Promise<ExternalApplicationWorkCensus>;
  ready(): Promise<boolean>;
  status(): Promise<MaintenanceStatus>;
  operation(action: 'begin' | 'cancel', body: unknown): number;
  handler(req: IncomingMessage, res: ServerResponse): void;
  readinessHandler: RequestHandler;
  admissionMiddleware: RequestHandler;
  mutationMiddleware: RequestHandler;
  listen(): Promise<void>;
  close(): Promise<void>;
}
const counters = [
  'initializing',
  'providerExecutions',
  'queuedContinuations',
  'pendingWrites',
  'activeStreams',
  'unresolved',
] as const;
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
function validCensus(value: unknown): value is GenerationMaintenanceCensus {
  return (
    object(value) &&
    exactKeys(value, ['admissionClosed', 'complete', ...counters]) &&
    typeof value.admissionClosed === 'boolean' &&
    typeof value.complete === 'boolean' &&
    counters.every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)
  );
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

/** Private process-local lifecycle composition. It never owns or fabricates provider records. */
export function createAppMaintenance(deps: MaintenanceDependencies): AppMaintenance {
  const token = deps.env.LIBRECHAT_MAINTENANCE_TOKEN;
  const controlEnabled = token !== undefined;
  const port = Number(deps.env.LIBRECHAT_MAINTENANCE_PORT ?? '3091');
  const identity = createMaintenanceIdentity(deps.env, controlEnabled || deps.requiredSharedState);
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
  let requestId: string | null = null;
  let revision = 0;
  let uncertain = false;
  let cancelled: { requestId: string; revision: number } | undefined;
  let listener: Server | undefined;
  const owners = Object.entries(deps.workOwners ?? {});
  const unqualifiedOwners = [...(deps.unqualifiedOwners ?? ['application coverage undeclared'])];
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
    try {
      const change =
        action === 'pauseAdmissions'
          ? deps.generation.closeGenerationAdmission
          : deps.generation.reopenGenerationAdmission;
      if (change.call(deps.generation, id) !== true) successful = false;
    } catch {
      successful = false;
    }
    return successful;
  }

  async function externalCensus(): Promise<ExternalApplicationWorkCensus> {
    const sampledRevision = revision;
    const sampledRequest = requestId;
    const samples = await Promise.all(
      owners.map(([, owner]) => observe(() => owner.getMaintenanceCensus(sampledRequest))),
    );
    let queuedContinuations = 0;
    let pendingWrites = 0;
    let complete = coverageDeclared && unqualifiedOwners.length === 0 && !uncertain;
    for (const sample of samples) {
      if (
        !object(sample) ||
        !exactKeys(sample, [
          'admissionClosed',
          'queuedContinuations',
          'pendingWrites',
          'complete',
        ]) ||
        typeof sample.complete !== 'boolean' ||
        sample.admissionClosed !== (sampledRequest !== null) ||
        !Number.isSafeInteger(sample.queuedContinuations) ||
        Number(sample.queuedContinuations) < 0 ||
        !Number.isSafeInteger(sample.pendingWrites) ||
        Number(sample.pendingWrites) < 0
      ) {
        complete = false;
        continue;
      }
      queuedContinuations += Number(sample.queuedContinuations);
      pendingWrites += Number(sample.pendingWrites);
      complete = complete && sample.complete;
    }
    if (!Number.isSafeInteger(queuedContinuations) || !Number.isSafeInteger(pendingWrites)) {
      return { queuedContinuations: 0, pendingWrites: 0, complete: false };
    }
    return {
      queuedContinuations,
      pendingWrites,
      complete:
        complete && sampledRevision === revision && sampledRequest === requestId && !uncertain,
    };
  }

  async function ready(): Promise<boolean> {
    if (
      (await observe(async () => deps.startupReady())) !== true ||
      requestId !== null ||
      uncertain
    ) {
      return false;
    }
    if (!controlEnabled && !deps.requiredSharedState) {
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
    const [census, external] = await Promise.all([
      observe(() => deps.generation.getGenerationAdmissionCensus()),
      externalCensus(),
    ]);
    const known =
      sampledRevision === revision &&
      validCensus(census) &&
      census.complete &&
      external.complete &&
      !uncertain;
    const drained =
      requestId !== null &&
      known &&
      census.admissionClosed &&
      external.queuedContinuations === 0 &&
      external.pendingWrites === 0 &&
      counters.every((key) => census[key] === 0);
    let phase: MaintenanceStatus['phase'] = requestId !== null ? 'quiescing' : 'running';
    if (drained) phase = 'drained';
    return {
      identity,
      requestId,
      revision,
      phase,
      known,
      census: known ? census : null,
      blockingReasons: [
        ...unqualifiedOwners,
        ...(!coverageDeclared ? ['application coverage undeclared'] : []),
        ...(!known ? ['census incomplete or admission uncertain'] : []),
      ],
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
    requestId = null;
    revision++;
    return 200;
  }
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      if (!controlEnabled || !loopback(req.socket.remoteAddress)) {
        reply(res, 403, { code: 'FORBIDDEN' });
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
  return {
    identity,
    externalCensus,
    ready,
    status,
    operation,
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
  externalCensus?: () => Promise<ExternalApplicationWorkCensus>;
  configure(options: {
    required: boolean;
    methods?: GenerationAdmissionMethods;
    ownerInstanceId: string;
    processBootId: string;
    externalCensus?: () => Promise<ExternalApplicationWorkCensus>;
  }): void;
}): Promise<void> {
  const methods: GenerationAdmissionMethods = {
    ensureGenerationAdmissionIndexes: deps.methods.ensureGenerationAdmissionIndexes,
    acquireGenerationAdmission: deps.methods.acquireGenerationAdmission,
    getGenerationAdmission: deps.methods.getGenerationAdmission,
    dispatchGenerationAdmission: deps.methods.dispatchGenerationAdmission,
    settleGenerationAdmission: deps.methods.settleGenerationAdmission,
    acquireGenerationAdmissionSuccessor: deps.methods.acquireGenerationAdmissionSuccessor,
    cancelUndispatchedGenerationAdmission: deps.methods.cancelUndispatchedGenerationAdmission,
    findGenerationAdmissionByEpoch: deps.methods.findGenerationAdmissionByEpoch,
    countUnsettledGenerationAdmissions: deps.methods.countUnsettledGenerationAdmissions,
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
    externalCensus: deps.externalCensus,
  });
}
