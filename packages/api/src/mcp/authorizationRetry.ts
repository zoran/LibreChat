import { randomUUID } from 'crypto';
import { logger } from '@librechat/data-schemas';
import type { MCPRecoveryGenerationScope } from './catalog/recovery';
import type { ApplicationWorkPort } from '../app/maintenance';
import { registerShutdownTask } from '../app/shutdown';

const DEFAULT_RETRY_INTERVAL_MS = 30_000;
const DEFAULT_RETRY_BATCH_SIZE = 100;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 1_000;

export interface MCPAuthorizationFenceRetryRecord extends MCPRecoveryGenerationScope {
  tenantId?: string | null;
  version: string;
  updatedAt: Date;
}

export interface MCPAuthorizationFenceRetryStorage {
  upsert(input: {
    scope: MCPRecoveryGenerationScope;
    tenantId?: string | null;
    version: string;
    now: Date;
  }): Promise<void>;
  deleteVersion(input: {
    scope: MCPRecoveryGenerationScope;
    tenantId?: string | null;
    version: string;
  }): Promise<void>;
  deferVersion(input: {
    scope: MCPRecoveryGenerationScope;
    tenantId?: string | null;
    version: string;
    updatedAt: Date;
  }): Promise<void>;
  list(limit: number): Promise<readonly MCPAuthorizationFenceRetryRecord[]>;
}

export interface MCPAuthorizationFenceRetryServiceDeps {
  storage: MCPAuthorizationFenceRetryStorage;
  getTenantId: () => string | null | undefined;
  runInRetryScope: (
    retry: MCPAuthorizationFenceRetryRecord,
    operation: () => Promise<void>,
  ) => Promise<void>;
  registerShutdown?: typeof registerShutdownTask;
}

export interface MCPAuthorizationFenceRetryWorkerPolicy {
  intervalMs?: number;
  batchSize?: number;
  attemptTimeoutMs?: number;
}

export interface MCPAuthorizationFenceRetryService {
  /** Original custody outlives bounded replay observation and deduplication. */
  maintenance: ApplicationWorkPort;
  clear(scope: MCPRecoveryGenerationScope, version: string): Promise<void>;
  drain(): Promise<void>;
  persist(scope: MCPRecoveryGenerationScope): Promise<string>;
  start(
    invalidator: (scope: MCPRecoveryGenerationScope) => Promise<unknown>,
    policy?: MCPAuthorizationFenceRetryWorkerPolicy,
  ): void;
  stop(): Promise<void>;
}

/** Owns durable authorization-fence retry lifecycle independently of the legacy server adapter. */
export function createMCPAuthorizationFenceRetryService(
  deps: MCPAuthorizationFenceRetryServiceDeps,
): MCPAuthorizationFenceRetryService {
  type RetryAttemptResult = { succeeded: true } | { succeeded: false; error: unknown };
  let retryTimer: ReturnType<typeof setInterval> | undefined;
  let drainPromise: Promise<void> | undefined;
  const activeAttempts = new Map<string, Promise<RetryAttemptResult>>();
  let invalidateRecoveryGeneration:
    | ((scope: MCPRecoveryGenerationScope) => Promise<unknown>)
    | undefined;
  let retryBatchSize = DEFAULT_RETRY_BATCH_SIZE;
  let attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS;
  let retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS;
  let requestId: string | null = null;
  let revision = 0;
  let stopped = false;
  let uncertain = false;
  const originals = new Set<Promise<unknown>>();

  const clearTimer = () => {
    if (retryTimer != null) clearInterval(retryTimer);
    retryTimer = undefined;
  };
  const admissionClosed = () => stopped || uncertain || requestId !== null;
  const markUncertain = () => {
    if (!uncertain) revision += 1;
    uncertain = true;
    clearTimer();
  };
  const own = <T>(operation: () => Promise<T>): Promise<T> => {
    // Register custody and both outcome observers before any producer can dispatch.
    const original = Promise.resolve().then(operation);
    originals.add(original);
    void original.then(
      () => originals.delete(original),
      () => {
        markUncertain();
        originals.delete(original);
      },
    );
    return original;
  };
  const closed = () => Promise.reject(new Error('MCP_AUTHORIZATION_RETRY_ADMISSION_CLOSED'));

  const attemptKey = (retry: MCPAuthorizationFenceRetryRecord): string =>
    JSON.stringify([retry.tenantId ?? '', retry.userId, retry.serverName, retry.version]);

  const getOrStartAttempt = (
    retry: MCPAuthorizationFenceRetryRecord,
    invalidate: (scope: MCPRecoveryGenerationScope) => Promise<unknown>,
  ): Promise<RetryAttemptResult> => {
    const key = attemptKey(retry);
    const activeAttempt = activeAttempts.get(key);
    if (activeAttempt != null) {
      return activeAttempt;
    }

    const scope = { userId: retry.userId, serverName: retry.serverName };
    const attempt = own(() =>
      deps.runInRetryScope(retry, async () => {
        await invalidate({ ...scope });
        await deps.storage.deleteVersion({
          scope,
          tenantId: retry.tenantId,
          version: retry.version,
        });
      }),
    ).then<RetryAttemptResult, RetryAttemptResult>(
      () => ({ succeeded: true }),
      (error: unknown) => ({ succeeded: false, error }),
    );
    activeAttempts.set(key, attempt);
    void attempt.then(() => {
      if (activeAttempts.get(key) === attempt) activeAttempts.delete(key);
    });
    return attempt;
  };

  const persist = (scope: MCPRecoveryGenerationScope): Promise<string> => {
    if (admissionClosed()) return closed();
    const version = randomUUID();
    const input = {
      scope: { ...scope },
      tenantId: deps.getTenantId() ?? null,
      version,
      now: new Date(),
    };
    return own(async () => {
      await deps.storage.upsert(input);
      return version;
    });
  };

  const clear = (scope: MCPRecoveryGenerationScope, version: string): Promise<void> => {
    if (admissionClosed()) return closed();
    const input = {
      scope: { ...scope },
      tenantId: deps.getTenantId() ?? null,
      version,
    };
    return own(() => deps.storage.deleteVersion(input));
  };

  const drain = (): Promise<void> => {
    if (drainPromise != null) return drainPromise;
    if (admissionClosed()) return closed();
    if (invalidateRecoveryGeneration == null) return Promise.resolve();
    // A paused/reconfigured worker cannot replace an already admitted batch's dependencies.
    const invalidate = invalidateRecoveryGeneration;
    const batchSize = retryBatchSize;
    const timeoutMs = attemptTimeoutMs;
    const batch = own(async () => {
      const retries = (await deps.storage.list(batchSize)).map((retry) => ({
        ...retry,
        updatedAt: new Date(retry.updatedAt),
      }));
      for (const retry of retries) {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        const key = attemptKey(retry);
        const attempt = getOrStartAttempt(retry, invalidate);
        try {
          const result = await Promise.race([
            attempt,
            new Promise<never>((_, reject) => {
              timeoutId = setTimeout(() => {
                timedOut = true;
                reject(new Error('MCP authorization generation replay timed out'));
              }, timeoutMs);
            }),
          ]);
          if (!result.succeeded) {
            throw result.error;
          }
        } catch (error) {
          logger.warn(
            `[MCP authorization] Durable generation retry failed for ${retry.serverName}`,
            error,
          );
          /** The underlying cache call may ignore cancellation. Retire it from deduplication so a
           * recovered dependency gets a fresh attempt; its exact-version delete remains safe if
           * the old promise eventually succeeds. */
          if (timedOut && activeAttempts.get(key) === attempt) {
            activeAttempts.delete(key);
          }
          try {
            let deferTimeoutId: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                own(() =>
                  deps.storage.deferVersion({
                    scope: { userId: retry.userId, serverName: retry.serverName },
                    tenantId: retry.tenantId,
                    version: retry.version,
                    updatedAt: new Date(Math.max(Date.now(), retry.updatedAt.getTime() + 1)),
                  }),
                ),
                new Promise<never>((_, reject) => {
                  deferTimeoutId = setTimeout(
                    () => reject(new Error('MCP authorization retry deferral timed out')),
                    timeoutMs,
                  );
                }),
              ]);
            } finally {
              if (deferTimeoutId != null) {
                clearTimeout(deferTimeoutId);
              }
            }
          } catch (deferError) {
            logger.warn(
              `[MCP authorization] Could not defer generation retry for ${retry.serverName}`,
              deferError,
            );
          }
        } finally {
          if (timeoutId != null) {
            clearTimeout(timeoutId);
          }
        }
      }
    });
    drainPromise = batch;
    const finished = () => {
      if (drainPromise === batch) drainPromise = undefined;
    };
    void batch.then(finished, finished);
    return batch;
  };

  const scheduleDrain = (): void => {
    if (admissionClosed()) return;
    void drain().catch((error) =>
      logger.warn('[MCP authorization] Could not read durable generation retries', error),
    );
  };

  const stopAdmissions = (): void => {
    if (!stopped) revision += 1;
    stopped = true;
    clearTimer();
  };
  const stop = async (): Promise<void> => {
    stopAdmissions();
    // Admitted batches can still produce descendants while shutdown waits.
    while (originals.size > 0) await Promise.allSettled([...originals]);
    if (uncertain) throw new Error('MCP_AUTHORIZATION_RETRY_SETTLEMENT_UNCONFIRMED');
  };
  const armTimer = (): void => {
    if (admissionClosed() || retryTimer != null || invalidateRecoveryGeneration == null) return;
    retryTimer = setInterval(scheduleDrain, retryIntervalMs);
    retryTimer.unref?.();
  };

  const start = (
    invalidator: (scope: MCPRecoveryGenerationScope) => Promise<unknown>,
    policy: MCPAuthorizationFenceRetryWorkerPolicy = {},
  ): void => {
    invalidateRecoveryGeneration = invalidator;
    retryBatchSize = policy.batchSize ?? DEFAULT_RETRY_BATCH_SIZE;
    attemptTimeoutMs = policy.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    retryIntervalMs = policy.intervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
    clearTimer();
    armTimer();
    scheduleDrain();
  };

  const maintenance: ApplicationWorkPort = {
    pauseAdmissions(id) {
      if (!id || (requestId !== null && requestId !== id)) return false;
      if (requestId === null) {
        requestId = id;
        revision += 1;
        clearTimer();
      }
      return true;
    },
    resumeAdmissions(id) {
      if (stopped || uncertain || requestId !== id) return false;
      requestId = null;
      revision += 1;
      armTimer();
      return true;
    },
    async getMaintenanceCensus(id) {
      const sampledRevision = revision;
      const matching = id === requestId;
      await Promise.resolve();
      return {
        admissionClosed: admissionClosed(),
        queuedContinuations: originals.size,
        pendingWrites: originals.size,
        complete: matching && sampledRevision === revision && !uncertain,
      };
    },
  };
  const register = deps.registerShutdown ?? registerShutdownTask;
  register('MCP authorization fence retry admissions', stopAdmissions, {
    phase: 'pre-drain',
    priority: 110,
  });
  register('MCP authorization fence retry worker', stop, { phase: 'pre-drain', priority: 90 });
  return { clear, drain, persist, start, stop, maintenance };
}
