/** Failed originals and cleanup cannot disappear behind a transaction-support Boolean. */
import { getTransactionSupport } from './transactions';

const { createPermissionMaintenance } = jest.requireActual(
  '../../../../api/server/services/PermissionMaintenance',
);
jest.mock('~/config/winston', () => ({ debug: jest.fn(), error: jest.fn(), warn: jest.fn() }));
function rejectsWith(original: Promise<unknown>, message: string) {
  return expect(original).rejects.toThrow(message);
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const client = {};
  const session = {
    client,
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(async () => {}),
    abortTransaction: jest.fn(async () => {}),
    endSession: jest.fn(async () => {}),
  };
  const read = jest.fn(async () => null);
  const db = { collection: jest.fn(() => ({ findOne: read })), createCollection: jest.fn() };
  const connection = {
    client,
    db,
    getClient: () => connection.client,
    startSession: jest.fn(async () => session),
  };
  const mongoose = { connection, startSession: jest.fn(() => connection.startSession()) };
  const source = mongoose as unknown as typeof import('mongoose');
  return { client, session, read, db, connection, source };
}
async function held(owner: ReturnType<typeof createPermissionMaintenance>) {
  expect(owner.pauseAdmissions('hold')).toBe(true);
  expect((await owner.getMaintenanceCensus('hold')).queuedContinuations).toBeGreaterThan(0);
}

describe('getTransactionSupport original custody', () => {
  it('preserves the unobserved cached Boolean API without touching a database', async () => {
    const source = {} as typeof import('mongoose');
    await expect(getTransactionSupport(source, true)).resolves.toBe(true);
    await expect(getTransactionSupport(source, false)).resolves.toBe(false);
  });

  it('retains both parents through one acquisition, read, commit and final end', async () => {
    const f = fixture();
    const acquisition = deferred<typeof f.session>();
    const read = deferred<null>();
    const commit = deferred();
    const end = deferred();
    f.connection.startSession.mockReturnValue(acquisition.promise);
    f.read.mockReturnValue(read.promise);
    f.session.commitTransaction.mockReturnValue(commit.promise);
    f.session.endSession.mockReturnValue(end.promise);
    const a = createPermissionMaintenance();
    const b = createPermissionMaintenance();
    const first = a.run((operation: never) => getTransactionSupport(f.source, null, operation));
    const second = b.run((operation: never) => getTransactionSupport(f.source, false, operation));
    await held(a);
    await held(b);
    expect(f.connection.startSession).toHaveBeenCalledTimes(1);
    acquisition.resolve(f.session);
    await flush();
    expect(f.read).toHaveBeenCalledTimes(1);
    await held(a);
    await held(b);
    read.resolve(null);
    await flush();
    expect(f.session.commitTransaction).toHaveBeenCalledTimes(1);
    await held(a);
    await held(b);
    commit.resolve();
    await flush();
    expect(f.session.endSession).toHaveBeenCalledTimes(1);
    await held(a);
    await held(b);
    end.resolve();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect((await a.getMaintenanceCensus('hold')).queuedContinuations).toBe(0);
    expect((await b.getMaintenanceCensus('hold')).complete).toBe(true);
  });

  it('does not share originals across different actual connections', async () => {
    const a = fixture();
    const b = fixture();
    const gate = deferred<null>();
    a.read.mockReturnValue(gate.promise);
    const first = getTransactionSupport(a.source, null);
    await expect(getTransactionSupport(b.source, null)).resolves.toBe(true);
    expect(a.connection.startSession).toHaveBeenCalledTimes(1);
    expect(b.connection.startSession).toHaveBeenCalledTimes(1);
    gate.resolve(null);
    await expect(first).resolves.toBe(true);
  });

  it('keeps every joining parent uncertain and forbids canary or reprobe after read failure', async () => {
    const f = fixture();
    const read = deferred<null>();
    f.read.mockReturnValue(read.promise);
    const a = createPermissionMaintenance();
    const b = createPermissionMaintenance();
    const first = a.run((operation: never) => getTransactionSupport(f.source, null, operation));
    const second = b.run((operation: never) => getTransactionSupport(f.source, null, operation));
    const outcomes = Promise.allSettled([first, second]);
    await flush();
    read.reject(new Error('original read failed'));
    await outcomes;
    for (const owner of [a, b]) {
      owner.pauseAdmissions('hold');
      expect((await owner.getMaintenanceCensus('hold')).complete).toBe(false);
      await expect(owner.drain()).rejects.toThrow('PERMISSION_SETTLEMENT_UNCONFIRMED');
    }
    const late = createPermissionMaintenance();
    await expect(
      late.run((operation: never) => getTransactionSupport(f.source, false, operation)),
    ).rejects.toThrow('original read failed');
    await expect(getTransactionSupport(f.source, null)).resolves.toBe(false);
    expect(f.connection.startSession).toHaveBeenCalledTimes(1);
    expect(f.db.createCollection).not.toHaveBeenCalled();
    expect(f.session.abortTransaction).toHaveBeenCalledTimes(1);
    expect(f.session.endSession).toHaveBeenCalledTimes(1);
  });

  it('owns only the acquired handle when the client changes during acquisition', async () => {
    const f = fixture();
    const acquisition = deferred<typeof f.session>();
    f.connection.startSession.mockReturnValue(acquisition.promise);
    const owner = createPermissionMaintenance();
    const original = owner.run((operation: never) =>
      getTransactionSupport(f.source, null, operation),
    );
    const outcome = rejectsWith(original, 'identity changed');
    f.connection.client = {};
    const replacement = { ...f.session, client: f.connection.client };
    acquisition.resolve(replacement);
    await outcome;
    expect(replacement.startTransaction).not.toHaveBeenCalled();
    expect(replacement.endSession).toHaveBeenCalledTimes(1);
    expect(f.read).not.toHaveBeenCalled();
  });

  it('does not dispatch commit against a Db replaced while the original read is pending', async () => {
    const f = fixture();
    const read = deferred<null>();
    f.read.mockReturnValue(read.promise);
    const owner = createPermissionMaintenance();
    const original = owner.run((operation: never) =>
      getTransactionSupport(f.source, null, operation),
    );
    const outcome = rejectsWith(original, 'identity changed');
    await flush();
    f.connection.db = { ...f.db, collection: jest.fn() };
    read.resolve(null);
    await outcome;
    expect(f.session.commitTransaction).not.toHaveBeenCalled();
    expect(f.connection.db.collection).not.toHaveBeenCalled();
    expect(f.session.endSession).toHaveBeenCalledTimes(1);
  });

  it('refuses missing Db and mismatched session.client before transaction start', async () => {
    const missing = fixture();
    missing.connection.db = undefined as never;
    await expect(getTransactionSupport(missing.source, null)).resolves.toBe(false);
    expect(missing.connection.startSession).not.toHaveBeenCalled();
    const mismatch = fixture();
    mismatch.session.client = {};
    await expect(getTransactionSupport(mismatch.source, null)).resolves.toBe(false);
    expect(mismatch.session.startTransaction).not.toHaveBeenCalled();
    expect(mismatch.session.endSession).toHaveBeenCalledTimes(1);
  });

  it('joins end after synchronous start failure and preserves the first failure through cleanup errors', async () => {
    const f = fixture();
    const end = deferred();
    f.session.startTransaction.mockImplementation(() => {
      throw new Error('start original');
    });
    f.session.abortTransaction.mockRejectedValue(new Error('abort cleanup'));
    f.session.endSession.mockReturnValue(end.promise);
    const owner = createPermissionMaintenance();
    const original = owner.run((operation: never) =>
      getTransactionSupport(f.source, null, operation),
    );
    const outcome = rejectsWith(original, 'start original');
    await flush();
    await held(owner);
    expect(f.session.endSession).toHaveBeenCalledTimes(1);
    end.reject(new Error('end cleanup'));
    await outcome;
    expect((await owner.getMaintenanceCensus('hold')).complete).toBe(false);
  });

  it('refuses a retired operation before acquiring any session', async () => {
    const f = fixture();
    const owner = createPermissionMaintenance();
    let captured: never;
    await owner.run((operation: never) => {
      captured = operation;
    });
    expect(() => getTransactionSupport(f.source, null, captured!)).toThrow('after settlement');
    expect(f.connection.startSession).not.toHaveBeenCalled();
  });

  it('does not memoize success after identity changes during end', async () => {
    const f = fixture();
    const end = deferred();
    f.session.endSession.mockReturnValue(end.promise);
    const owner = createPermissionMaintenance();
    const original = owner.run((operation: never) =>
      getTransactionSupport(f.source, null, operation),
    );
    const outcome = rejectsWith(original, 'identity changed');
    await flush();
    f.connection.client = {};
    end.resolve();
    await outcome;
    expect(f.connection.startSession).toHaveBeenCalledTimes(1);
  });
});
