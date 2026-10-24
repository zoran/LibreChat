/** Transaction capability originals belong to their actual connection, client and Db. */
import type { ClientSession, Connection } from 'mongoose';
import type { AuthContinuationObserver } from '~/methods/authPersistence';
import logger from '~/config/winston';

export const CANCEL_RATE = 1.15;
const TRANSACTION_PROBE_COLLECTION = '__transaction_test__';
type Mongoose = typeof import('mongoose');
type Probe = {
  mongoose: Mongoose;
  connection: Connection;
  client: ReturnType<Connection['getClient']>;
  db: Connection['db'];
  original: Promise<boolean>;
  steps: Set<Promise<unknown>>;
  observers: Set<AuthContinuationObserver>;
  session?: ClientSession;
  settled: boolean;
  uncertain: boolean;
  error?: unknown;
};
const probes = new WeakMap<Connection, Probe>();

function failed(probe: Probe, error: unknown): void {
  if (!probe.uncertain) probe.error = error;
  probe.uncertain = true;
  for (const observer of probe.observers) observer.markUncertain();
}

function assertCurrent(probe: Probe): void {
  // client is a pinned MongoDB 6.20.0 internal. Absence or drift refuses dispatch.
  if (
    !probe.client ||
    !probe.db ||
    probe.mongoose.connection !== probe.connection ||
    probe.connection.getClient() !== probe.client ||
    probe.connection.db !== probe.db ||
    (probe.session && (probe.session as unknown as { client?: unknown }).client !== probe.client)
  )
    throw new Error('Transaction original connection or session identity changed');
}

async function step<T>(
  probe: Probe,
  observer: AuthContinuationObserver | undefined,
  write: boolean,
  action: () => Promise<T> | T,
  mode: 'effect' | 'acquire' | 'cleanup' = 'effect',
): Promise<T> {
  const start = async () => {
    if (mode !== 'cleanup') assertCurrent(probe);
    const original = Promise.resolve(action());
    probe.steps.add(original);
    const result = await original;
    if (mode === 'effect') assertCurrent(probe);
    return result;
  };
  try {
    if (!observer) return await start();
    if (write) return await observer.write(start);
    return await observer.track(start);
  } catch (error) {
    failed(probe, error);
    throw error;
  }
}

async function execute(probe: Probe, observer?: AuthContinuationObserver): Promise<boolean> {
  let started = false;
  let supported = false;
  try {
    probe.session = await step(
      probe,
      observer,
      false,
      () => probe.connection.startSession(),
      'acquire',
    );
    // Own the returned handle before checking acquisition drift or attempting start.
    assertCurrent(probe);
    const session = probe.session;
    started = true;
    await step(probe, observer, true, () => session.startTransaction());
    await step(probe, observer, false, () =>
      probe.db!.collection(TRANSACTION_PROBE_COLLECTION).findOne({}, { session }),
    );
    await step(probe, observer, true, () => session.commitTransaction());
    supported = true;
  } catch (error) {
    failed(probe, error);
    if (probe.session && started) {
      try {
        await step(probe, observer, true, () => probe.session!.abortTransaction(), 'cleanup');
      } catch (abortError) {
        logger.error('[supportsTransactions] Error aborting transaction:', abortError);
      }
    }
    logger.debug('MongoDB transaction original is unconfirmed:', error);
  } finally {
    if (probe.session) {
      try {
        await step(probe, observer, false, () => probe.session!.endSession(), 'cleanup');
      } catch (endError) {
        logger.error('[supportsTransactions] Error ending session:', endError);
      }
    }
    try {
      assertCurrent(probe);
    } catch (error) {
      failed(probe, error);
    }
    probe.settled = true;
    if (!probe.uncertain) probe.observers.clear();
  }
  return supported && !probe.uncertain;
}

function observeProbe(mongoose: Mongoose, observer?: AuthContinuationObserver): Promise<boolean> {
  const join = async () => {
    const connection = mongoose.connection;
    if (!connection) {
      observer?.markUncertain();
      if (observer) throw new Error('Transaction original has no connection');
      return false;
    }
    const client = connection.getClient();
    const db = connection.db;
    let probe = probes.get(connection);
    if (probe && (probe.client !== client || probe.db !== db)) {
      if (probe.settled && !probe.uncertain) probe = undefined;
      else failed(probe, new Error('Transaction original connection identity changed'));
    }
    if (!probe) {
      let finish!: (value: boolean) => void;
      const original = new Promise<boolean>((resolve) => {
        finish = resolve;
      });
      probe = {
        mongoose,
        connection,
        client,
        db,
        original,
        steps: new Set(),
        observers: new Set(observer ? [observer] : []),
        settled: false,
        uncertain: false,
      };
      probes.set(connection, probe);
      // The caller's track has registered retention, and the record already owns this original.
      void execute(probe, observer).then(finish);
    } else if (observer) {
      probe.observers.add(observer);
    }
    if (probe.uncertain) observer?.markUncertain();
    const supported = await probe.original;
    if (probe.uncertain && observer) {
      observer.markUncertain();
      throw probe.error ?? new Error('Transaction original remains unconfirmed');
    }
    if (!probe.uncertain && observer) probe.observers.delete(observer);
    return supported;
  };
  return observer ? observer.track(join) : join();
}

/**
 * A failed original is not a clean unsupported verdict: never create a canary or reprobe it.
 * Observed callers reject after owned cleanup; unobserved callers retain the Boolean API.
 * Fulfilled abort/end only releases local resources and does not qualify server disposition.
 */
export const supportsTransactions = (
  mongoose: Mongoose,
  observer?: AuthContinuationObserver,
): Promise<boolean> => observeProbe(mongoose, observer);

/** Only unobserved callers may use their historical, unbound Boolean cache. */
export const getTransactionSupport = (
  mongoose: Mongoose,
  transactionSupportCache: boolean | null,
  observer?: AuthContinuationObserver,
): Promise<boolean> => {
  if (!observer && transactionSupportCache !== null)
    return Promise.resolve(transactionSupportCache);
  return observeProbe(mongoose, observer);
};
