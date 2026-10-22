/** One bounded global domain observation; no replica metrics, invented coverage or file metadata. */
import { HOUSEKEEPING_HANDLERS } from 'librechat-data-provider';
import type { StatusHousekeeping, StatusHousekeepingHandler } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { HousekeepingCoverage } from '../types/housekeeping';
import type { HousekeepingOwners } from '../types/housekeeping';
import type { HousekeepingStore } from './housekeepingStore';
import { createFileHousekeepingDiscoveryMethods } from './fileHousekeepingDiscovery';
import { readUploadHousekeepingCoverage } from './uploadHousekeeping';
import { HOUSEKEEPING_INDEXES } from '../models/housekeepingJob';
import { HOUSEKEEPING_STORE_POLICY } from './housekeepingStore';

type Domain = StatusHousekeeping['domain'];
const empty = (): StatusHousekeepingHandler['values'] => ({
  pendingCount: null,
  overdueCount: null,
  oldestOverdueSeconds: null,
  activeClaimsCount: null,
  expiredClaimsCount: null,
  notificationUnknownCount: null,
  recoveredClaimsCount: null,
  lastRecoveryAt: null,
});
function unavailable(aborted: boolean): Domain {
  return {
    observation: {
      state: aborted ? 'unknown' : 'unavailable',
      reason: aborted ? 'not_measured' : 'source_unavailable',
      evidence: [],
    },
    handlers: HOUSEKEEPING_HANDLERS.map((handler) => ({
      handler,
      quality: 'unknown',
      coverage: { expected: null, observed: 0 },
      values: empty(),
    })),
  };
}
function validCoverage(value: HousekeepingCoverage): boolean {
  return (
    Number.isInteger(value?.observed) &&
    value.observed >= 0 &&
    value.observed <= 1000000 &&
    (value.expected === null ||
      (Number.isInteger(value.expected) &&
        value.expected >= value.observed &&
        value.expected <= 1000000)) &&
    ['complete', 'partial', 'unknown'].includes(value.recoveryHistory)
  );
}
interface AggregateRow {
  _id: string;
  pending: number;
  overdue: number;
  oldest: Date | null;
  active: number;
  expired: number;
  unknown: number;
  recovered: number;
  lastRecovery: Date | null;
}

export async function readHousekeepingStatus(
  store: Pick<HousekeepingStore, 'model'>,
  owners: Pick<HousekeepingOwners, 'coverage'>,
  sourceId: string,
  signal: AbortSignal,
): Promise<Domain> {
  if (signal.aborted) return unavailable(true);
  try {
    const session = await store.model.db.startSession({ snapshot: true, causalConsistency: false });
    let result: Domain;
    try {
      result = await readSnapshot(store, owners, sourceId, signal, session);
    } finally {
      // Keep session closure owned too; cancellation cannot detach the original DB/owner work.
      await session.endSession();
    }
    return signal.aborted ? unavailable(true) : result;
  } catch {
    return unavailable(signal.aborted);
  }
}

async function readSnapshot(
  store: Pick<HousekeepingStore, 'model'>,
  owners: Pick<HousekeepingOwners, 'coverage'>,
  sourceId: string,
  signal: AbortSignal,
  session: ClientSession,
): Promise<Domain> {
  if (signal.aborted) return unavailable(true);
  const pending = {
    $and: [
      { $in: ['$state', ['queued', 'waiting', 'claimed', 'unknown']] },
      { $lte: ['$dueAt', '$$NOW'] },
    ],
  };
  const overdue = { $and: [pending, { $lt: ['$dueAt', '$$NOW'] }] };
  const claimed = { $eq: ['$state', 'claimed'] };
  const expired = { $and: [claimed, { $lte: ['$claim.leaseUntil', '$$NOW'] }] };
  try {
    // The three-row result remains bounded. maxTimeMS limits an incomplete aggregate; a timeout
    // produces unknown values, never a truncated aggregate presented as complete.
    // eslint-disable-next-line no-restricted-syntax -- Trusted global Status aggregate returns only bounded counts, without tenant/subject identifiers.
    const rows = await store.model.collection
      .aggregate<{ rows: AggregateRow[]; observedAt: Date }>(
        [
          { $match: { handler: { $in: [...HOUSEKEEPING_HANDLERS] } } },
          {
            $facet: {
              rows: [
                {
                  $group: {
                    _id: '$handler',
                    pending: { $sum: { $cond: [pending, 1, 0] } },
                    overdue: { $sum: { $cond: [overdue, 1, 0] } },
                    oldest: { $min: { $cond: [overdue, '$dueAt', null] } },
                    active: {
                      $sum: {
                        $cond: [{ $and: [claimed, { $gt: ['$claim.leaseUntil', '$$NOW'] }] }, 1, 0],
                      },
                    },
                    expired: { $sum: { $cond: [expired, 1, 0] } },
                    unknown: {
                      $sum: {
                        $cond: [
                          {
                            $and: [
                              { $eq: ['$handler', 'file.warning'] },
                              {
                                $or: [
                                  { $eq: ['$state', 'unknown'] },
                                  { $and: [expired, { $eq: ['$execution.phase', 'armed'] }] },
                                ],
                              },
                            ],
                          },
                          1,
                          0,
                        ],
                      },
                    },
                    recovered: { $sum: '$recoveries' },
                    lastRecovery: { $max: '$lastRecoveryAt' },
                  },
                },
              ],
            },
          },
          { $project: { rows: 1, observedAt: '$$NOW' } },
        ],
        {
          session,
          maxTimeMS: HOUSEKEEPING_STORE_POLICY.queryMs,
          timeoutMS: HOUSEKEEPING_STORE_POLICY.queryMs,
          readConcern: { level: 'snapshot' },
          hint: HOUSEKEEPING_INDEXES.due,
          signal,
        },
      )
      .toArray();
    if (signal.aborted || rows.length !== 1) return unavailable(signal.aborted);
    const observedAt = rows[0].observedAt.getTime() / 1000;
    const handlers: Domain['handlers'] = [];
    for (const handler of HOUSEKEEPING_HANDLERS) {
      let coverage: HousekeepingCoverage;
      try {
        // The session pins coverage to the count snapshot, even if backfill has since committed.
        coverage = await owners.coverage(handler, signal, session);
      } catch {
        coverage = { expected: null, observed: 0, recoveryHistory: 'unknown' };
      }
      if (signal.aborted) return unavailable(true);
      if (!validCoverage(coverage) || coverage.observed === 0) {
        handlers.push({
          handler,
          quality: 'unknown',
          coverage: { expected: null, observed: 0 },
          values: empty(),
        });
        continue;
      }
      const result = rows[0].rows.find((row) => row._id === handler);
      const values: StatusHousekeepingHandler['values'] = {
        pendingCount: result?.pending ?? 0,
        overdueCount: result?.overdue ?? 0,
        oldestOverdueSeconds: result?.oldest
          ? Math.max(0, observedAt - result.oldest.getTime() / 1000)
          : 0,
        activeClaimsCount: result?.active ?? 0,
        expiredClaimsCount: result?.expired ?? 0,
        notificationUnknownCount: result?.unknown ?? 0,
        recoveredClaimsCount:
          coverage.recoveryHistory === 'unknown' ? null : (result?.recovered ?? 0),
        lastRecoveryAt:
          coverage.recoveryHistory === 'unknown' || !result?.lastRecovery
            ? null
            : result.lastRecovery.getTime() / 1000 || null,
      };
      if (
        Object.entries(values).some(
          ([key, value]) =>
            value !== null &&
            (!Number.isFinite(value) ||
              value < 0 ||
              (!['oldestOverdueSeconds', 'lastRecoveryAt'].includes(key) &&
                !Number.isSafeInteger(value))),
        )
      ) {
        handlers.push({
          handler,
          quality: 'unknown',
          coverage: { expected: null, observed: 0 },
          values: empty(),
        });
        continue;
      }
      // Partial retained recovery history cannot be presented under a complete row label.
      const full =
        coverage.expected !== null &&
        coverage.expected > 0 &&
        coverage.expected === coverage.observed &&
        coverage.recoveryHistory !== 'partial';
      handlers.push({
        handler,
        quality: full ? 'complete' : 'partial',
        coverage: { expected: full ? coverage.expected : null, observed: coverage.observed },
        values,
      });
    }
    const known = handlers.filter((handler) => handler.quality !== 'unknown').length;
    if (!known) return unavailable(false);
    return {
      observation: {
        state: 'fresh',
        reason: handlers.every((row) => row.quality === 'complete')
          ? 'observed'
          : 'partial_coverage',
        evidence: [
          { sourceId, observedAt, maxAgeSeconds: 90, coverage: { expected: 3, observed: known } },
        ],
      },
      handlers,
    };
  } catch {
    return unavailable(signal.aborted);
  }
}

/** Compose only existing registered owners; startup retains all model/index/migration writes. */
export function createHousekeepingStatusReader(
  mongoose: typeof import('mongoose'),
): (signal: AbortSignal) => Promise<Domain> {
  return (signal: AbortSignal): Promise<Domain> => {
    const model = mongoose.models.HousekeepingJob as HousekeepingStore['model'] | undefined;
    if (signal.aborted || !model || model.db.readyState !== 1 || !mongoose.models.File)
      return Promise.resolve(unavailable(signal.aborted));
    const files = createFileHousekeepingDiscoveryMethods(mongoose);
    const owners: Pick<HousekeepingOwners, 'coverage'> = {
      coverage: (handler, cancellation, session) =>
        handler === 'upload.cleanup'
          ? readUploadHousekeepingCoverage(mongoose, cancellation, session)
          : files.coverage(handler, cancellation, session),
    };
    // Upload observes its own scope; complete projection and recovery history remain unproved.
    return readHousekeepingStatus({ model }, owners, 'application-housekeeping', signal);
  };
}
