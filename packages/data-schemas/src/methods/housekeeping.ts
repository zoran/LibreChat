/** Public worker facade: domain discovery is injected; execution cannot certify File/Upload facts. */
import type { HousekeepingOwners, HousekeepingRepository, RetryCode } from '../types/housekeeping';
import type { HousekeepingStore } from './housekeepingStore';
import { readHousekeepingStatus } from './housekeepingStatus';
import { assertHandler } from './housekeepingStore';

export type { HousekeepingOwners } from '../types/housekeeping';

export interface HousekeepingRepositoryOptions {
  sourceId: string;
}
export function createHousekeepingRepository(
  store: HousekeepingStore,
  owners: HousekeepingOwners,
  options: HousekeepingRepositoryOptions,
): HousekeepingRepository {
  if (!/^[A-Za-z0-9_.-]{1,96}$/.test(options.sourceId)) throw Error('HOUSEKEEPING_INVALID');
  const retries: readonly RetryCode[] = [
    'owner_pending',
    'external_pending',
    'not_accepted',
    'source_unavailable',
    'insufficient_send_budget',
  ];
  return {
    async discover(handler, cursor) {
      assertHandler(handler);
      if (cursor !== null && (typeof cursor !== 'string' || cursor.length > 1024))
        throw Error('HOUSEKEEPING_INVALID');
      const page = await owners.discover(handler, cursor);
      if (
        !Number.isInteger(page.scanned) ||
        page.scanned < 0 ||
        page.scanned > 32 ||
        typeof page.complete !== 'boolean' ||
        !(page.cursor === null || (typeof page.cursor === 'string' && page.cursor.length <= 1024))
      )
        throw Error('HOUSEKEEPING_INVALID_PAGE');
      return page;
    },
    claimNext: (handler, worker) => store.claimNext(handler, worker),
    renew: (ownership) => store.renew(ownership),
    async inspect(jobId, executionId) {
      try {
        const row = await store.observe(jobId, executionId);
        if (!row) return { state: 'missing' };
        return {
          state: 'observed',
          jobId: row._id,
          executionId: row.execution.id,
          jobState: row.state,
          phase: row.execution.phase,
          progressRevision: row.progressRevision,
          receiptRef: row.execution.receiptRef,
          code: row.lastCode,
        };
      } catch {
        return { state: 'unknown' };
      }
    },
    async defer(claim, reason) {
      if (!retries.includes(reason)) throw Error('HOUSEKEEPING_INVALID');
      try {
        return (await store.release(claim, false, reason)) ? 'recorded' : 'lost';
      } catch {
        return 'unknown';
      }
    },
    async releaseUnstarted(claim) {
      try {
        return (await store.release(claim, true, 'released')) ? 'recorded' : 'lost';
      } catch {
        return 'unknown';
      }
    },
    readStatus: (signal) => readHousekeepingStatus(store, owners, options.sourceId, signal),
  };
}
