/** Standalone lifecycle composition. Domain owners and owned resources are mandatory caller ports. */
import express from 'express';
import { createServer } from 'node:http';
import type { HousekeepingRepository, WorkerIdentity } from '@librechat/data-schemas';
import type { Server } from 'node:http';
import type { AppMaintenance, MaintenanceIdentity } from '../app/maintenance';
import type { HousekeepingRuntime, HousekeepingDrain } from './runtime';
import type { StorageProviders } from '../storage/providerObservation';
import type { HousekeepingHandlerDependencies } from './handlers';
import {
  registerShutdownTask,
  requestGracefulShutdown,
  setupGracefulShutdown,
} from '../app/shutdown';
import { HOUSEKEEPING_POLICY, housekeepingIdentity } from './config';
import { createWorkloadMaintenance } from '../app/maintenance';
import { createMaintenanceIdentity } from '../app/identity';
import { createHousekeepingHandlers } from './handlers';
import { createHousekeepingRuntime } from './runtime';
import { createMetrics } from '../app/metrics';

export interface HousekeepingApplicationDependencies extends HousekeepingHandlerDependencies {
  env: Record<string, string | undefined>;
  repository: HousekeepingRepository;
  readStorageProviders(): StorageProviders;
  /** Close only this process's actual resources after original runtime and startup work settles. */
  close(signal: AbortSignal): Promise<void>;
}

export interface HousekeepingApplication {
  identity: WorkerIdentity;
  /** Native release must read the current maintenance revision and match this exact incarnation. */
  startupHold: Readonly<{ requestId: string; identity: MaintenanceIdentity; expectedRevision: 0 }>;
  runtime: HousekeepingRuntime;
  maintenance: AppMaintenance;
  start(): Promise<void>;
  drain(): Promise<HousekeepingDrain>;
}

function requirePorts(deps: HousekeepingApplicationDependencies): void {
  const methods = [
    deps.close,
    deps.readStorageProviders,
    ...(
      [
        'discover',
        'claimNext',
        'renew',
        'inspect',
        'defer',
        'releaseUnstarted',
        'readStatus',
      ] as const
    ).map((name) => deps.repository?.[name]),
    deps.fileNotice?.prepare,
    deps.fileNotice?.authorizeHandoff,
    deps.fileNotice?.recordOutcome,
    deps.fileCleanup?.step,
    deps.uploadCleanup?.step,
  ];
  if (methods.some((method) => typeof method !== 'function'))
    throw new Error('Incomplete Housekeeping owner ports');
}

async function closeListener(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

/** No domain factory fallback or startup release exists here. Construction never admits work. */
export function createHousekeepingApplication(
  deps: HousekeepingApplicationDependencies,
): HousekeepingApplication {
  requirePorts(deps);
  const env = { ...deps.env };
  if (
    !env.METRICS_SECRET ||
    env.METRICS_SECRET !== process.env.METRICS_SECRET ||
    env.METRICS_SECRET === env.LIBRECHAT_MAINTENANCE_TOKEN ||
    Number(env.LIBRECHAT_MAINTENANCE_PORT ?? '3091') !== 3091
  )
    throw new Error('Invalid Housekeeping listener configuration');
  const maintenanceIdentity = createMaintenanceIdentity(env, true);
  const identity = housekeepingIdentity({
    ...maintenanceIdentity,
    hostId: env.POD_NODE_NAME ?? '',
  });
  const startupHold = Object.freeze({
    requestId: `startup_${identity.incarnation}`,
    identity: maintenanceIdentity,
    expectedRevision: 0 as const,
  });
  let opening: Promise<void> | undefined;
  let startPromise: Promise<void> | undefined;
  let stopping = false;
  let started = false;
  let maintenanceListening = false;
  const runtime = createHousekeepingRuntime({
    identity,
    repository: deps.repository,
    handlers: createHousekeepingHandlers(deps),
    close: async (signal) => {
      // Partial startup retains its original bind promise before any resource close.
      await opening?.catch(() => undefined);
      if (signal.aborted) throw new Error('Housekeeping resource close deadline reached');
      await deps.close(signal);
      if (signal.aborted) throw new Error('Housekeeping resource close deadline reached');
      if (maintenanceListening) await maintenance.close();
      if (signal.aborted) throw new Error('Housekeeping resource close deadline reached');
      await closeListener(server);
      metrics.detachHousekeepingMetrics();
    },
  });
  const maintenance = createWorkloadMaintenance({
    env,
    identity: maintenanceIdentity,
    workOwners: { housekeeping: runtime },
    fileDomainOwners: ['housekeeping'],
    readStorageProviders: () => deps.readStorageProviders(),
    startupReady: () => started && !stopping,
  });
  const metrics = createMetrics({ collectHousekeepingObservation: () => runtime.observe() });
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (req.method !== 'GET' || !['/metrics', '/health'].includes(req.originalUrl)) {
      res.status(404).end();
      return;
    }
    next();
  });
  app.use('/metrics', metrics.metricsRouter);
  app.get('/health', maintenance.readinessHandler);
  const server = createServer(app);
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.maxHeadersCount = 20;

  const drain = (): Promise<HousekeepingDrain> => {
    stopping = true;
    started = false;
    return runtime.drain();
  };
  async function open(): Promise<void> {
    await maintenance.listen();
    maintenanceListening = true;
    if (stopping) throw new Error('Housekeeping stopped during startup');
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      server.once('error', failed);
      server.listen(3080, '127.0.0.1', () => {
        server.off('error', failed);
        resolve();
      });
    });
    if (stopping) throw new Error('Housekeeping stopped during startup');
    started = true;
  }
  return Object.freeze({
    identity,
    startupHold,
    runtime,
    maintenance,
    drain,
    start(): Promise<void> {
      if (startPromise) return startPromise;
      if (stopping) return Promise.reject(new Error('Housekeeping is already draining'));
      setupGracefulShutdown(server, {
        timeoutMs: HOUSEKEEPING_POLICY.drainMs,
        deferHttpCloseUntilPreDrain: true,
      });
      registerShutdownTask(
        'housekeeping original work',
        async () => {
          const result = await drain();
          if (result.state !== 'closed') throw new Error('Housekeeping drain unresolved');
        },
        { phase: 'pre-drain' },
      );
      if (maintenance.operation('begin', startupHold) === 200) {
        runtime.start();
        opening = open();
      } else {
        opening = Promise.reject(new Error('Housekeeping startup hold unconfirmed'));
      }
      startPromise = opening.catch(async (error: unknown) => {
        // Start the process deadline before drain can wait on unresolved resource custody.
        // Its pre-drain task joins this same drain; awaiting shutdown here would form a cycle.
        void requestGracefulShutdown('startup_failure').catch(() => undefined);
        const result = await drain();
        if (result.state !== 'closed')
          throw Object.assign(new Error('Housekeeping startup failed with unresolved custody'), {
            cause: error,
          });
        throw error;
      });
      return startPromise;
    },
  });
}
