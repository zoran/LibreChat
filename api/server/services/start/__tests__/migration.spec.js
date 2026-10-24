/** Actual startup/check/helper composition retains DDL and cursor cleanup before normalization. */
jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@librechat/api', () => ({
  checkAgentPermissionsMigration: jest.fn(
    jest.requireActual('../../../../../packages/api/src/agents/migration')
      .checkAgentPermissionsMigration,
  ),
  checkPromptPermissionsMigration: jest.fn(
    jest.requireActual('../../../../../packages/api/src/prompts/migration')
      .checkPromptPermissionsMigration,
  ),
  logAgentMigrationWarning: jest.fn(),
  logPromptMigrationWarning: jest.fn(),
}));
jest.mock('~/models', () => ({ findRoleByIdentifier: jest.fn() }));

const api = require('@librechat/api');
const { createStartupMigrationChecks } = require('../migration');
const { ensureCollectionExists } = jest.requireActual('../../../../../packages/api/src/db/utils');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
function fixture() {
  const cursors = [];
  const fallback = jest.fn(async () => null);
  const db = {
    listCollections: jest.fn(() => {
      const cursor = {
        toArray: jest.fn(async () => [{ name: 'existing' }]),
        close: jest.fn(async () => {}),
      };
      cursors.push(cursor);
      return cursor;
    }),
    createCollection: jest.fn(async () => ({})),
    collection: jest.fn(() => ({ findOne: fallback })),
  };
  const connection = {
    db,
    client: {},
    getClient() {
      return this.client;
    },
  };
  const mongoose = { connection, models: { Agent: {}, PromptGroup: {} } };
  const findRoleByIdentifier = jest.fn(async () => null);
  const owner = createStartupMigrationChecks({ mongoose, findRoleByIdentifier });
  const firstCursor = (overrides) => {
    const cursor = {
      toArray: jest.fn(async () => []),
      close: jest.fn(async () => {}),
      ...overrides,
    };
    db.listCollections.mockImplementationOnce(() => {
      cursors.push(cursor);
      return cursor;
    });
    return cursor;
  };
  return { owner, db, connection, mongoose, findRoleByIdentifier, fallback, cursors, firstCursor };
}

describe('startup migration collection custody', () => {
  beforeEach(() => jest.clearAllMocks());

  it('retains actual DDL and captured cleanup through pause and original drain', async () => {
    const f = fixture();
    const create = deferred();
    const close = deferred();
    const cursor = f.firstCursor({ close: jest.fn(() => close.promise) });
    f.db.createCollection.mockReturnValueOnce(create.promise);
    const original = f.owner.checkMigrations();
    expect(f.owner.checkMigrations()).toBe(original);
    await tick();
    expect(f.db.createCollection).toHaveBeenCalledTimes(1);
    expect(f.owner.maintenance.pauseAdmissions('hold')).toBe(true);
    expect(await f.owner.maintenance.getMaintenanceCensus('hold')).toMatchObject({
      admissionClosed: true,
      queuedContinuations: 1,
      pendingWrites: 1,
    });
    let drained = false;
    const drain = f.owner.drain().then(() => {
      drained = true;
    });
    create.resolve({});
    await tick();
    expect(cursor.close).toHaveBeenCalledTimes(1);
    expect(drained).toBe(false);
    expect(await f.owner.maintenance.getMaintenanceCensus('hold')).toMatchObject({
      queuedContinuations: 1,
      pendingWrites: 0,
    });
    close.resolve();
    await original;
    await drain;
    expect(drained).toBe(true);
    expect(f.cursors).toHaveLength(14);
    for (const owned of f.cursors) expect(owned.close).toHaveBeenCalledTimes(1);
    expect(await f.owner.maintenance.getMaintenanceCensus('hold')).toMatchObject({
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
  });

  it('rejects a create failure normalized by the predecessor helper', async () => {
    const f = fixture();
    const cursor = f.firstCursor({});
    const failure = new Error('original collection creation failed');
    f.db.createCollection.mockRejectedValueOnce(failure);
    await expect(f.owner.checkMigrations()).rejects.toBe(failure);
    expect(cursor.close).toHaveBeenCalledTimes(1);
    expect(f.fallback).not.toHaveBeenCalled();
    expect(f.db.listCollections).toHaveBeenCalledTimes(1);
    expect(api.checkPromptPermissionsMigration).not.toHaveBeenCalled();
    expect(f.owner.maintenance.pauseAdmissions('hold')).toBe(true);
    expect((await f.owner.maintenance.getMaintenanceCensus('hold')).complete).toBe(false);
    expect(f.owner.maintenance.resumeAdmissions('hold')).toBe(false);
    await expect(f.owner.drain()).rejects.toBe(failure);
  });

  it('keeps the first DDL failure while captured cursor cleanup is pending and rejects', async () => {
    const f = fixture();
    const create = deferred();
    const close = deferred();
    const cursor = f.firstCursor({ close: jest.fn(() => close.promise) });
    const failure = new Error('first DDL failure');
    f.db.createCollection.mockReturnValueOnce(create.promise);
    const original = f.owner.checkMigrations();
    const outcome = original.catch((error) => error);
    await tick();
    create.reject(failure);
    await tick();
    expect(cursor.close).toHaveBeenCalledTimes(1);
    f.owner.maintenance.pauseAdmissions('hold');
    expect(await f.owner.maintenance.getMaintenanceCensus('hold')).toMatchObject({
      queuedContinuations: 1,
      complete: false,
    });
    close.reject(new Error('later cleanup failure'));
    expect(await outcome).toBe(failure);
    await expect(f.owner.drain()).rejects.toBe(failure);
  });

  it.each(['db', 'client', 'connection'])(
    'closes only the captured cursor after %s identity drift before DDL',
    async (changed) => {
      const f = fixture();
      const read = deferred();
      const close = deferred();
      const cursor = f.firstCursor({
        toArray: jest.fn(() => read.promise),
        close: jest.fn(() => close.promise),
      });
      const original = f.owner.checkMigrations();
      const outcome = original.catch((error) => error);
      await tick();
      if (changed === 'connection') f.mongoose.connection = { ...f.connection };
      else f.connection[changed] = {};
      read.resolve([]);
      await tick();
      expect(f.db.createCollection).not.toHaveBeenCalled();
      expect(cursor.close).toHaveBeenCalledTimes(1);
      f.owner.maintenance.pauseAdmissions('hold');
      expect((await f.owner.maintenance.getMaintenanceCensus('hold')).queuedContinuations).toBe(1);
      close.resolve();
      expect(await outcome).toMatchObject({
        message: 'Startup migration database binding changed',
      });
      expect(cursor.close).toHaveBeenCalledTimes(1);
    },
  );

  it('retains synchronous cursor acquisition failure without inventing a cleanup handle', async () => {
    const f = fixture();
    const failure = new Error('cursor acquisition failed');
    f.db.listCollections.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(f.owner.checkMigrations()).rejects.toBe(failure);
    expect(f.cursors).toHaveLength(0);
    expect(f.db.createCollection).not.toHaveBeenCalled();
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it('keeps a cleanup-only rejection uncertain before the next collection', async () => {
    const f = fixture();
    const failure = new Error('cursor close failed');
    const cursor = f.firstCursor({
      toArray: jest.fn(async () => [{ name: 'existing' }]),
      close: jest.fn(async () => {
        throw failure;
      }),
    });
    await expect(f.owner.checkMigrations()).rejects.toBe(failure);
    expect(cursor.close).toHaveBeenCalledTimes(1);
    expect(f.db.createCollection).not.toHaveBeenCalled();
    expect(f.db.listCollections).toHaveBeenCalledTimes(1);
    await expect(f.owner.drain()).rejects.toBe(failure);
  });

  it('refuses missing Db before collection dispatch', async () => {
    const f = fixture();
    f.connection.db = undefined;
    await expect(f.owner.checkMigrations()).rejects.toThrow('database binding changed');
    expect(f.db.listCollections).not.toHaveBeenCalled();
  });

  it('refuses a new startup check while paused or stopped and accepts only its matching resume', async () => {
    const f = fixture();
    expect(f.owner.maintenance.pauseAdmissions('hold')).toBe(true);
    expect(() => f.owner.checkMigrations()).toThrow('APP_QUIESCING');
    expect(f.db.listCollections).not.toHaveBeenCalled();
    expect(f.owner.maintenance.resumeAdmissions('foreign')).toBe(false);
    expect(f.owner.maintenance.resumeAdmissions('hold')).toBe(true);
    await f.owner.checkMigrations();
    const other = fixture();
    other.owner.stopAdmissions();
    expect(() => other.owner.checkMigrations()).toThrow('APP_QUIESCING');
    expect(other.db.listCollections).not.toHaveBeenCalled();
  });

  it('preserves later migration lookup failure before its zero-count compatibility result', async () => {
    const f = fixture();
    const failure = new Error('original role lookup failed');
    f.findRoleByIdentifier.mockRejectedValueOnce(failure);
    await expect(f.owner.checkMigrations()).rejects.toBe(failure);
    expect(f.cursors).toHaveLength(7);
    expect(api.checkPromptPermissionsMigration).not.toHaveBeenCalled();
  });

  it('rejects a retained observer after its startup original settled', async () => {
    const f = fixture();
    await f.owner.checkMigrations();
    const { observer } = api.checkAgentPermissionsMigration.mock.calls[0][0];
    const late = jest.fn(async () => {});
    await expect(observer.write(late)).rejects.toThrow('after settlement');
    expect(late).not.toHaveBeenCalled();
    await expect(f.owner.drain()).rejects.toThrow('after settlement');
  });

  it('preserves unobserved operator compatibility without claiming collection creation', async () => {
    const f = fixture();
    const cursor = f.firstCursor({});
    f.db.createCollection.mockRejectedValueOnce(new Error('compatibility creation failure'));
    await expect(ensureCollectionExists(f.db, 'operator')).resolves.toBeUndefined();
    expect(cursor.close).toHaveBeenCalledTimes(1);
    expect(f.fallback).toHaveBeenCalledWith({}, { projection: { _id: 1 } });
  });
});
