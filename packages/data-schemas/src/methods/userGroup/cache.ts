/** Membership cache and transaction invalidation lifecycle; state is shared across factories. */
import { Types } from 'mongoose';
import { AsyncLocalStorage } from 'async_hooks';
import { CacheKeys } from 'librechat-data-provider';
import type { Model, ClientSession } from 'mongoose';
import type { AuthContinuationObserver, AuthPersistenceObserver } from '../authPersistence';
import type { CacheStore, IGroup } from '~/types';
import { observeAuthPersistence } from '../authPersistence';
import { isValidObjectIdString } from '~/utils/objectId';
import { scopedCacheKey } from '~/config/tenantContext';

export interface UserGroupDeps {
  /** Returns the USER_PRINCIPALS cache store when principal caching is enabled. From getLogStores. */
  getCache?: (key: string) => CacheStore | undefined;
  /**
   * Notified after membership caches are invalidated so access caches derived from
   * memberships (e.g. prompt group access IDs) drop their stale entries too.
   */
  onMemberGroupsInvalidated?: (observer?: AuthPersistenceObserver) => void | Promise<void>;
}

type PendingGroupLookup = { promise: Promise<Types.ObjectId[]>; markStale: () => void };

/** Same-process dedup of concurrent cache builds, keyed by scoped member cache key. */
const pendingGroupLookups = new Map<string, PendingGroupLookup>();
const GROUP_LOCK_POLL_MS = 50;
/** Above this many member keys, invalidation clears the namespace instead of fanning out deletes. */
const INVALIDATION_CLEAR_THRESHOLD = 1000;
/** Fallback delay for the second invalidation pass when the store sets none. */
const DEFAULT_STALE_EVICTION_DELAY_MS = 3000;

const isCachedGroupId = (value: unknown): value is string =>
  typeof value === 'string' && isValidObjectIdString(value);

type DeferredInvalidation = {
  /** ALS snapshot (tenant scoping) captured where the mutation ran. */
  run: (invalidate: () => Promise<void>) => Promise<void>;
  invalidate: () => Promise<void>;
  observer?: AuthContinuationObserver;
  finish: () => void;
};

/** One queue and one set of lifecycle hooks per session, so many mutations in one
 * transaction cannot trip the emitter's max-listeners warning. */
const sessionInvalidations = new WeakMap<ClientSession, DeferredInvalidation[]>();
const hookedSessions = new WeakSet<ClientSession>();

async function drainSessionInvalidations(
  session: ClientSession,
  queue: DeferredInvalidation[] | undefined,
): Promise<void> {
  if (!queue) {
    return;
  }
  if (sessionInvalidations.get(session) !== queue) {
    for (const entry of queue) entry.observer?.markUncertain();
    return;
  }
  sessionInvalidations.delete(session);
  await Promise.all(
    queue.map(async (entry) => {
      try {
        await entry.run(entry.invalidate);
      } catch {
        entry.observer?.markUncertain();
      } finally {
        entry.finish();
      }
    }),
  );
}

/** Release a cancelled queue, preserving any already-recorded uncertain write outcome. */
function discardSessionInvalidations(session: ClientSession, uncertain: boolean): void {
  const queue = sessionInvalidations.get(session);
  sessionInvalidations.delete(session);
  for (const entry of queue ?? []) {
    if (uncertain) entry.observer?.markUncertain();
    entry.finish();
  }
}

function hookSessionLifecycle(session: ClientSession): void {
  if (hookedSessions.has(session)) {
    return;
  }
  hookedSessions.add(session);

  const commitTransaction = session.commitTransaction.bind(session);
  session.commitTransaction = async (
    ...args: Parameters<ClientSession['commitTransaction']>
  ): Promise<void> => {
    const queue = sessionInvalidations.get(session);
    try {
      await commitTransaction(...args);
    } catch (error) {
      // Keep the queue for a supported retry. A later abort cannot erase this uncertainty.
      for (const entry of queue ?? []) entry.observer?.markUncertain();
      throw error;
    }
    await drainSessionInvalidations(session, queue);
  };

  const abortTransaction = session.abortTransaction.bind(session);
  session.abortTransaction = async (
    ...args: Parameters<ClientSession['abortTransaction']>
  ): Promise<void> => {
    const queue = sessionInvalidations.get(session);
    try {
      await abortTransaction(...args);
    } catch (error) {
      for (const entry of queue ?? []) entry.observer?.markUncertain();
      throw error;
    } finally {
      if (sessionInvalidations.get(session) === queue) {
        discardSessionInvalidations(session, false);
      }
    }
  };

  const startTransaction = session.startTransaction.bind(session);
  session.startTransaction = (...args: Parameters<ClientSession['startTransaction']>): void => {
    startTransaction(...args);
    // Successful session reuse must not replay callbacks from an unproven prior transaction.
    discardSessionInvalidations(session, true);
  };

  session.once('ended', () => {
    discardSessionInvalidations(session, true);
  });
}

/**
 * Runs cache invalidation immediately, or defers it to commit for transactional
 * writes. Mid-transaction invalidation would let concurrent readers re-cache pre-commit
 * state with no later correction; deferring keeps the existing entry serving the
 * still-committed old memberships until the transaction commits. Aborts discard the queue.
 */
export function runAfterTransaction(
  session: ClientSession | undefined,
  invalidate: () => Promise<void>,
  observer?: AuthContinuationObserver,
): Promise<void> {
  if (!session?.inTransaction()) {
    return invalidate();
  }
  let finish = () => {};
  if (observer) {
    // Register before returning to the caller that will eventually commit/abort this session.
    const retained = observer.track(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    void retained.catch(() => observer.markUncertain());
  }
  const deferred: DeferredInvalidation = {
    run: AsyncLocalStorage.snapshot(),
    invalidate,
    observer,
    finish,
  };
  const queue = sessionInvalidations.get(session);
  if (queue) {
    queue.push(deferred);
    return Promise.resolve();
  }
  const newQueue: DeferredInvalidation[] = [deferred];
  sessionInvalidations.set(session, newQueue);
  hookSessionLifecycle(session);
  return Promise.resolve();
}

export interface UserGroupCache {
  getMemberGroupIds: (memberId: string, session?: ClientSession) => Promise<Types.ObjectId[]>;
  invalidateMemberGroupsCache: (
    memberIds: Array<string | Types.ObjectId | undefined | null>,
    observer?: AuthContinuationObserver,
  ) => Promise<void>;
  clearMemberGroupsCache: (observer?: AuthContinuationObserver) => Promise<void>;
}

/** One cache dependency instance per public group-method composition. */
export function createUserGroupCache(
  mongoose: typeof import('mongoose'),
  deps: UserGroupDeps,
): UserGroupCache {
  const getPrincipalsCache = (): CacheStore | undefined =>
    deps.getCache?.(CacheKeys.USER_PRINCIPALS);

  async function queryGroupIds(
    memberId: string,
    session?: ClientSession,
    readPrimary = false,
  ): Promise<Types.ObjectId[]> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const groupsQuery = Group.find({ memberIds: memberId }, { _id: 1 });
    if (session) {
      groupsQuery.session(session);
    }
    if (readPrimary && !session) {
      /**
       * Cache builds must not capture a lagging secondary's pre-mutation state for the
       * full TTL (`secondaryPreferred` deployments); uncached reads keep the connection
       * default, where staleness is bounded by replication lag as before.
       */
      groupsQuery.read('primary');
    }
    const groups = await groupsQuery.lean<Array<Pick<IGroup, '_id'>>>();
    return groups.map((group) => group._id);
  }

  async function readCachedGroupIds(
    cache: CacheStore,
    cacheKey: string,
  ): Promise<Types.ObjectId[] | undefined> {
    try {
      const cached = await cache.get(cacheKey);
      if (Array.isArray(cached) && cached.every(isCachedGroupId)) {
        return cached.map((groupId) => new Types.ObjectId(groupId));
      }
    } catch {
      /** Cache failures must not block permission checks. */
    }
    return undefined;
  }

  /**
   * Resolves group ids for a member key (`idOnTheSource` for external users, else the
   * raw user id), cached per member. Concurrent same-process misses share one build;
   * Redis-backed stores also dedupe cross-process builds via a short-lived lock.
   * Session-scoped reads bypass the cache entirely.
   */
  async function getMemberGroupIds(
    memberId: string,
    session?: ClientSession,
  ): Promise<Types.ObjectId[]> {
    const cache = session ? undefined : getPrincipalsCache();
    if (!cache) {
      return queryGroupIds(memberId, session);
    }

    const cacheKey = scopedCacheKey(memberId);
    const fastPath = await readCachedGroupIds(cache, cacheKey);
    if (fastPath) {
      return fastPath;
    }

    const pending = pendingGroupLookups.get(cacheKey);
    if (pending) {
      return pending.promise;
    }

    /** Invalidation flips this so an in-flight build skips its now-stale cache write. */
    let stale = false;
    /**
     * The `_LOCK` prefix keeps raw lock keys disjoint from Keyv data keys
     * (always `USER_PRINCIPALS:<key>`), even for member ids ending in `:lock`.
     */
    const lockKey = `${CacheKeys.USER_PRINCIPALS}_LOCK:${cacheKey}`;
    const lookup = (async (): Promise<Types.ObjectId[]> => {
      let lockToken: string | null | undefined;
      try {
        if (cache.acquireLock) {
          let lockFailed = false;
          try {
            lockToken = await cache.acquireLock(lockKey);
          } catch {
            lockFailed = true;
          }
          if (!lockToken && !lockFailed) {
            const waitUntil = Date.now() + Math.max(cache.lockWaitMs ?? 0, 0);
            while (Date.now() < waitUntil) {
              await new Promise((resolve) => setTimeout(resolve, GROUP_LOCK_POLL_MS));
              const cached = await readCachedGroupIds(cache, cacheKey);
              if (cached) {
                return cached;
              }
              /**
               * Re-attempt the lock each tick: a holder whose write was invalidated away
               * (or that crashed) never fills the key, so take over the build as soon as
               * the lock frees instead of sleeping out the full wait budget.
               */
              try {
                lockToken = await cache.acquireLock(lockKey);
              } catch {
                break;
              }
              if (lockToken) {
                break;
              }
            }
          }
          if (lockToken) {
            /** Another process may have filled the key between the fast-path miss and the lock. */
            const cached = await readCachedGroupIds(cache, cacheKey);
            if (cached) {
              return cached;
            }
          }
        }

        const groupIds = await queryGroupIds(memberId, undefined, true);
        if (!stale) {
          try {
            await cache.set(
              cacheKey,
              groupIds.map((groupId) => groupId.toString()),
            );
          } catch {
            /** Cache failures must not block permission checks. */
          }
        }
        return groupIds;
      } finally {
        if (lockToken) {
          try {
            await cache.releaseLock?.(lockKey, lockToken);
          } catch {
            /** Lock cleanup failures expire via the lock TTL. */
          }
        }
      }
    })();

    /**
     * Registered synchronously (no await between the pending check and this set) so every
     * concurrent same-process caller attaches to this single flow instead of starting its own.
     */
    pendingGroupLookups.set(cacheKey, {
      promise: lookup,
      markStale: () => {
        stale = true;
      },
    });
    try {
      return await lookup;
    } finally {
      if (pendingGroupLookups.get(cacheKey)?.promise === lookup) {
        pendingGroupLookups.delete(cacheKey);
      }
    }
  }

  async function dropMemberKeys(
    cache: CacheStore,
    cacheKeys: Set<string>,
    observer?: AuthPersistenceObserver,
  ): Promise<void> {
    for (const cacheKey of cacheKeys) {
      const pending = pendingGroupLookups.get(cacheKey);
      if (pending) {
        pending.markStale();
        pendingGroupLookups.delete(cacheKey);
      }
    }
    try {
      await Promise.all(
        [...cacheKeys].map((cacheKey) =>
          observeAuthPersistence(observer, async () => cache.delete?.(cacheKey)),
        ),
      );
    } catch {
      /** Cache failures must not block membership updates. */
    }
  }

  /**
   * Cross-process builds cannot see this process's stale flags, so a build in another
   * container that read pre-mutation state can re-cache it after the first delete.
   * A delayed second pass evicts such rewrites on stores shared across processes,
   * independent of build locking; the store supplies the delay budget.
   */
  function scheduleSecondInvalidation(
    cache: CacheStore,
    secondPass: () => Promise<void>,
    observer?: AuthContinuationObserver,
  ): void {
    if (!cache.crossProcess) {
      return;
    }
    const graceMs = Math.max(cache.staleEvictionDelayMs ?? DEFAULT_STALE_EVICTION_DELAY_MS, 0);
    const schedule = () =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          void secondPass().then(resolve, reject);
        }, graceMs);
        timer.unref?.();
      });
    // Retain the grace interval as well as its eventual writes, without delaying the caller.
    const retained = observer ? observer.track(schedule) : schedule();
    void retained.catch(() => observer?.markUncertain());
  }

  /**
   * Drops cached group memberships for the given member keys (both base and
   * tenant-scoped variants) after a membership mutation. In-flight builds are
   * marked stale (skipping their cache write) and unregistered so later reads
   * start a fresh build instead of joining a pre-mutation one. Failures are
   * non-fatal; the cache TTL bounds any residual staleness (e.g. mutations
   * running under a different tenant context than the member's reads).
   */
  /**
   * Notifies dependent access caches after memberships have been evicted, never
   * before: a dependent rebuild that runs first would read the stale membership
   * and cache its derived IDs under the freshly bumped generation, surviving
   * the membership eviction that should have prevented them.
   */
  const notifyMemberGroupsInvalidated = async (
    observer?: AuthContinuationObserver,
  ): Promise<void> => {
    try {
      await deps.onMemberGroupsInvalidated?.(observer);
    } catch {
      observer?.markUncertain();
      /** Dependent cache invalidation must not block membership updates. */
    }
  };

  async function invalidateMemberGroupsCache(
    memberIds: Array<string | Types.ObjectId | undefined | null>,
    observer?: AuthContinuationObserver,
  ): Promise<void> {
    const cache = getPrincipalsCache();
    if (!cache?.delete) {
      await notifyMemberGroupsInvalidated(observer);
      return;
    }
    const cacheKeys = new Set<string>();
    for (const memberId of memberIds) {
      if (!memberId) {
        continue;
      }
      const baseKey = memberId.toString();
      cacheKeys.add(baseKey);
      cacheKeys.add(scopedCacheKey(baseKey));
    }
    if (cacheKeys.size === 0) {
      return;
    }
    if (cacheKeys.size > INVALIDATION_CLEAR_THRESHOLD && cache.clear) {
      return clearMemberGroupsCache(observer);
    }
    const evict = async (): Promise<void> => {
      await dropMemberKeys(cache, cacheKeys, observer);
      await notifyMemberGroupsInvalidated(observer);
    };
    await evict();
    scheduleSecondInvalidation(cache, evict, observer);
  }

  /** Clears the whole membership cache when affected members cannot be enumerated. */
  async function clearMemberGroupsCache(observer?: AuthContinuationObserver): Promise<void> {
    const cache = getPrincipalsCache();
    if (!cache?.clear) {
      await notifyMemberGroupsInvalidated(observer);
      return;
    }
    const clearAll = async (): Promise<void> => {
      for (const pending of pendingGroupLookups.values()) {
        pending.markStale();
      }
      pendingGroupLookups.clear();
      try {
        await observeAuthPersistence(observer, async () => cache.clear?.());
      } catch {
        /** Cache failures must not block membership updates. */
      }
      await notifyMemberGroupsInvalidated(observer);
    };
    await clearAll();
    scheduleSecondInvalidation(cache, clearAll, observer);
  }
  return { getMemberGroupIds, invalidateMemberGroupsCache, clearMemberGroupsCache };
}
