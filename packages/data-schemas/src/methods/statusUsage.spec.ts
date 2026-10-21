import mongoose from 'mongoose';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { EmailCodeGrant } from '~/types/emailCode';
import { STATUS_USAGE_STORAGE_LIMITS as L } from '../types/statusUsage';
import { createStatusUsageMethods } from './statusUsage';

describe('bounded durable application usage', () => {
  let mongo: MongoMemoryReplSet;
  let port: ReturnType<typeof createStatusUsageMethods>;
  let now: number;
  let grant: EmailCodeGrant;
  const commandEvidence: Record<string, unknown>[] = [];
  const faultEvidence: Record<string, unknown>[] = [];
  const ownedTransactionSessions = new Map<string, object>();
  const fail = (commands: string[], blockTimeMS: number, times: number | 'alwaysOn' = 1) =>
    mongoose.connection.db!.admin().command({
      configureFailPoint: 'failCommand',
      mode: times === 'alwaysOn' ? times : { times },
      data: {
        failCommands: commands,
        blockConnection: true,
        blockTimeMS,
        appName: 'status-usage-fault-qualification',
      },
    });
  const clearFault = () =>
    mongoose.connection.db!.admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
  const serverOutcome = async () => {
    const status = await mongoose.connection.db!.admin().command({ serverStatus: 1 });
    return {
      openTransactions: status.transactions.currentOpen,
      activeTransactions: status.transactions.currentActive,
      openCursors: status.metrics.cursor.open.total,
      receipts: await mongoose.models.StatusUsageReceipt.countDocuments({}).maxTimeMS(2000),
    };
  };
  const observeFault = async <T>(name: string, operation: () => Promise<T>) => {
    const start = performance.now(),
      firstCommand = commandEvidence.length;
    let value: T | undefined;
    let error: { name?: string; message?: string; code?: number } | undefined;
    try {
      value = await operation();
    } catch (failure) {
      error = failure as typeof error;
    }
    const elapsedMs = performance.now() - start;
    const commands = commandEvidence.slice(firstCommand);
    const server = await serverOutcome();
    let evidenceValue: unknown = value;
    if (typeof value !== 'string' && Array.isArray(value)) {
      evidenceValue = {
        rows: value.length,
        allUnknown: value.every(
          (row) => row.activeUsers === null && row.publishedDocuments === null,
        ),
      };
    }
    faultEvidence.push({
      name,
      elapsedMs,
      error: error ? { name: error.name, message: error.message, code: error.code } : null,
      value: evidenceValue,
      serverAtReturn: server,
      commands,
    });
    return { value, error, elapsedMs, commands, server };
  };
  beforeAll(async () => {
    const dbPath = await mkdtemp(process.env.TMPDIR + '/status-usage-db-');
    mongo = await MongoMemoryReplSet.create({
      replSet: { count: 1, ip: '127.0.0.1' },
      instanceOpts: [{ dbPath, args: ['--setParameter', 'enableTestCommands=1'] }],
    });
    await mongoose.connect(mongo.getUri(), {
      monitorCommands: true,
      appName: 'status-usage-fault-qualification',
    });
    mongoose.connection.getClient().on('commandStarted', (event) => {
      if (event.command.autocommit === false && event.command.lsid)
        ownedTransactionSessions.set(JSON.stringify(event.command.lsid), event.command.lsid);
      if (
        [
          'find',
          'getMore',
          'update',
          'insert',
          'commitTransaction',
          'abortTransaction',
          'killCursors',
        ].includes(event.commandName)
      )
        commandEvidence.push({
          phase: 'started',
          name: event.commandName,
          atMs: performance.now(),
          requestId: event.requestId,
          maxTimeMS: event.command.maxTimeMS ?? null,
          inTransaction: event.command.autocommit === false,
        });
    });
    mongoose.connection.getClient().on('commandSucceeded', (event) => {
      commandEvidence.push({
        phase: 'succeeded',
        name: event.commandName,
        atMs: performance.now(),
        requestId: event.requestId,
        durationMs: event.duration,
      });
    });
    mongoose.connection.getClient().on('commandFailed', (event) => {
      commandEvidence.push({
        phase: 'failed',
        name: event.commandName,
        atMs: performance.now(),
        requestId: event.requestId,
        durationMs: event.duration,
        failure: event.failure.name,
        code: (event.failure as Error & { code?: number }).code,
      });
    });
    mongoose.model(
      'User',
      new mongoose.Schema({
        tenantId: String,
        authVersion: Number,
        provider: String,
        emailVerified: Boolean,
        authDisabled: Boolean,
        agentTriggerDeletionStartedAt: Date,
        credentialsChangedAt: Date,
        twoFactorEnrolledAt: Date,
      }),
    );
    mongoose.model(
      'Session',
      new mongoose.Schema({
        tenantId: String,
        user: mongoose.Schema.Types.ObjectId,
        authMethod: String,
        authVersion: Number,
        authPolicyVersion: Number,
        authCreatedAt: Date,
        expiration: Date,
        idleExpiresAt: Date,
        revokedAt: Date,
      }),
    );
    port = createStatusUsageMethods(mongoose, {
      scopeId: 'cortex',
      tenantId: 'tenant',
      clock: () => now,
    });
  });
  afterAll(async () => {
    if (process.env.STATUS_USAGE_FAULT_EVIDENCE)
      await writeFile(
        process.env.STATUS_USAGE_FAULT_EVIDENCE,
        JSON.stringify(
          { driver: 'mongodb 6.20.0', mongoose: '8.24.1', cases: faultEvidence },
          null,
          2,
        ) + '\n',
      );
    await mongoose.disconnect();
    await mongo?.stop();
  });
  afterEach(async () => {
    await clearFault();
    // Test-only teardown: a timed-out abort can leave the isolated server transaction open.
    // Killing these exact test-owned sessions is not an application settlement mechanism.
    if (ownedTransactionSessions.size)
      await mongoose.connection.db!.admin().command(
        {
          killSessions: [...ownedTransactionSessions.values()],
          maxTimeMS: 2000,
        },
        { timeoutMS: 2000 },
      );
    ownedTransactionSessions.clear();
  });
  beforeEach(async () => {
    now = Math.floor(Date.now() / 1000) * 1000;
    for (const model of Object.values(mongoose.models)) await model.deleteMany({});
    const user = await mongoose.models.User.create({
      tenantId: 'tenant',
      authVersion: 1,
      provider: 'email_code',
      emailVerified: true,
    });
    const session = await mongoose.models.Session.create({
      tenantId: 'tenant',
      user: user._id,
      authMethod: 'email_code',
      authVersion: 1,
      authPolicyVersion: 1,
      authCreatedAt: new Date(now - 86400000),
      expiration: new Date(now + 30 * 86400000),
      idleExpiresAt: new Date(now + 30 * 86400000),
    });
    grant = {
      tenantId: 'tenant',
      userId: String(user._id),
      sessionId: String(session._id),
      authVersion: 1,
      policyVersion: 1,
      refreshGeneration: 0,
      createdAt: now - 86400000,
      absoluteExpiresAt: now + 30 * 86400000,
      idleExpiresAt: now + 30 * 86400000,
    };
    await port.initialize();
  });
  const publish = (operationId: string, at = now - 1000) =>
    mongoose.connection.transaction((session) =>
      port.recordOriginalPublication(
        { tenantId: 'tenant', operationId, publishedAtMs: at },
        session,
      ),
    );

  it('initializes 168 unknown slots without exact-zero usage', async () => {
    expect(await port.readTrailingHour(now)).toMatchObject({
      activeUsers: null,
      publishedDocuments: null,
      complete: false,
    });
    const history = await port.readCompletedHours(now);
    expect(history).toHaveLength(168);
    expect(
      history.every(
        (row) => row.activeUsers === null && row.publishedDocuments === null && !row.complete,
      ),
    ).toBe(true);
  });
  it('deduplicates concurrent action writes and preserves exact earlier cutoff membership', async () => {
    const at = now - 1000;
    const results = await Promise.all([
      port.recordAuthorizedAction({ grant, authorizedAtMs: at }),
      port.recordAuthorizedAction({ grant, authorizedAtMs: at }),
    ]);
    expect(results.sort()).toEqual(['duplicate', 'recorded']);
    await port.recordAuthorizedAction({ grant, authorizedAtMs: now });
    expect(await port.readTrailingHour(now)).toMatchObject({ activeUsers: 1, complete: false });
    expect(await mongoose.models.StatusUsageReceipt.countDocuments({ kind: 'activity_hour' })).toBe(
      1,
    );
    expect(
      (await mongoose.models.StatusUsageBucket.findOne({ kind: 'hour' }).lean<{
        active: number;
      }>())!.active,
    ).toBe(1);
  });
  it('visible presence is monotonic and never extends the auth session', async () => {
    const before = await mongoose.models.Session.findById(grant.sessionId).lean<{
      idleExpiresAt: Date;
    }>();
    expect(await port.recordVisiblePresence({ grant, visibleObservedAtMs: now - 1000 })).toBe(
      'recorded',
    );
    expect(await port.recordVisiblePresence({ grant, visibleObservedAtMs: now - 2000 })).toBe(
      'duplicate',
    );
    const row = await mongoose.models.StatusUsageReceipt.findOne({ kind: 'presence' }).lean<{
      leaseUntilMs: number;
    }>();
    expect(row!.leaseUntilMs).toBe(now + 89000);
    expect(
      (await mongoose.models.Session.findById(grant.sessionId).lean<{ idleExpiresAt: Date }>())!
        .idleExpiresAt,
    ).toEqual(before!.idleExpiresAt);
  });
  it('preserves implicit native auth version zero and rejects a retired version', async () => {
    await mongoose.models.User.updateOne({ _id: grant.userId }, { $unset: { authVersion: 1 } });
    await mongoose.models.Session.updateOne({ _id: grant.sessionId }, { $set: { authVersion: 0 } });
    grant.authVersion = 0;
    expect(await port.recordAuthorizedAction({ grant, authorizedAtMs: now - 1000 })).toBe(
      'recorded',
    );
    await mongoose.models.User.updateOne({ _id: grant.userId }, { $set: { authVersion: 1 } });
    await expect(port.recordVisiblePresence({ grant, visibleObservedAtMs: now })).rejects.toThrow(
      'STATUS_USAGE_GRANT',
    );
  });
  it('returns unknown history when its existing control owner is unavailable', async () => {
    await mongoose.models.StatusUsageBucket.deleteOne({ kind: 'control' });
    const rows = await port.readCompletedHours(now);
    expect(rows).toHaveLength(168);
    expect(
      rows.every(
        (row) =>
          row.activeUsers === null &&
          row.publishedDocuments === null &&
          !row.complete &&
          row.gap === 'producer_gap',
      ),
    ).toBe(true);
  });
  it('rejects cross-kind fields and inactive model attempt records', async () => {
    const common = {
      _id: 'a'.repeat(64),
      schemaVersion: 1,
      scopeId: 'cortex',
      tenantId: 'tenant',
      revision: 0,
      createdAtMs: now,
      updatedAtMs: now,
      expiresAt: new Date(now + 1000),
    };
    const crossKind = new mongoose.models.StatusUsageReceipt({
      ...common,
      kind: 'document_publication',
      publishedAtMs: now,
      hourStartMs: Math.floor(now / 3600000) * 3600000,
      userId: grant.userId,
    });
    await expect(crossKind.validate()).rejects.toThrow('STATUS_USAGE_RECEIPT');
    await expect(
      new mongoose.models.StatusUsageReceipt({ ...common, kind: 'model_attempt' }).validate(),
    ).rejects.toThrow();
  });
  it('publication is once-only and rolls back with the existing owner transaction', async () => {
    expect(await publish('first')).toBe('recorded');
    expect(await publish('first')).toBe('duplicate');
    expect(await publish('first', now - 2000)).toBe('conflict');
    await expect(
      mongoose.connection.transaction(async (session) => {
        await port.recordOriginalPublication(
          { tenantId: 'tenant', operationId: 'rollback', publishedAtMs: now - 1000 },
          session,
        );
        throw Error('owner rollback');
      }),
    ).rejects.toThrow('owner rollback');
    expect(
      await mongoose.models.StatusUsageReceipt.countDocuments({ kind: 'document_publication' }),
    ).toBe(1);
    expect(await port.readTrailingHour(now)).toMatchObject({
      publishedDocuments: 1,
      complete: false,
    });
  });
  it('publication quota refusal commits its coverage gap and permits the owner transaction', async () => {
    await mongoose.models.StatusUsageBucket.updateOne(
      { kind: 'control' },
      { $set: { reservedReceipts: L.receiptReservations } },
    );
    await mongoose.connection.transaction(async (session) => {
      expect(
        await port.recordOriginalPublication(
          { tenantId: 'tenant', operationId: 'quota', publishedAtMs: now - 1000 },
          session,
        ),
      ).toBe('capacity');
      await mongoose.models.User.updateOne(
        { _id: grant.userId },
        { $inc: { __v: 1 } },
        { session },
      );
    });
    expect(
      (await mongoose.models.StatusUsageBucket.findOne({ kind: 'control' }).lean<{
        documentsGap: string;
      }>())!.documentsGap,
    ).toBe('capacity');
    expect(await mongoose.models.StatusUsageReceipt.countDocuments({})).toBe(0);
  });
  it('deletion purges subject receipts, preserves totals and fences late recreation', async () => {
    await port.recordAuthorizedAction({ grant, authorizedAtMs: now - 1000 });
    await port.recordVisiblePresence({ grant, visibleObservedAtMs: now - 1000 });
    await mongoose.models.User.updateOne(
      { _id: grant.userId },
      { $set: { agentTriggerDeletionStartedAt: new Date(now) } },
    );
    expect(
      await port.purgeSubject({ tenantId: 'tenant', userId: grant.userId, fenceStartedAtMs: now }),
    ).toEqual({ removed: 2, more: false });
    expect(await mongoose.models.StatusUsageReceipt.countDocuments({ userId: grant.userId })).toBe(
      0,
    );
    expect(
      (await mongoose.models.StatusUsageBucket.findOne({ kind: 'hour' }).lean<{
        active: number;
      }>())!.active,
    ).toBe(1);
    await expect(port.recordAuthorizedAction({ grant, authorizedAtMs: now })).rejects.toThrow(
      'principal_unavailable',
    );
    expect(await port.readTrailingHour(now)).toMatchObject({
      gap: 'purged_activity',
      complete: false,
    });
  });
  it('retention watermark prevents replay after cleanup and rejects an old collector epoch', async () => {
    const at = now - 1000;
    await publish('retention', at);
    const first = await port.acquireCollector('first');
    now += 9 * 86400000;
    const next = await port.acquireCollector('next');
    await expect(port.advanceRetention(first!)).rejects.toThrow('STATUS_USAGE_FENCE');
    await port.advanceRetention(next!);
    expect(await publish('retention', at)).toBe('expired');
    expect(await mongoose.models.StatusUsageReceipt.countDocuments({})).toBe(0);
    expect(
      (await mongoose.models.StatusUsageBucket.findOne({ kind: 'control' }).lean<{
        reservedReceipts: number;
      }>())!.reservedReceipts,
    ).toBe(0);
    expect(
      (await port.readCompletedHours(now)).every((row) => row.publishedDocuments === null),
    ).toBe(true);
  });
  it('fault: transaction commands share the actual eight-second work budget', async () => {
    await fail(['find'], 3000);
    const result = await observeFault('slow command inside transaction', () =>
      port.recordAuthorizedAction({ grant, authorizedAtMs: now - 1000 }),
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toBe('recorded');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(2800);
    expect(result.elapsedMs).toBeLessThan(8000);
    expect(result.server.receipts).toBe(1);
    expect(result.server.openTransactions).toBe(0);
    expect(
      result.commands.some(
        (command) =>
          command.phase === 'started' &&
          command.name === 'find' &&
          Number(command.maxTimeMS) > 2000 &&
          Number(command.maxTimeMS) <= 8000,
      ),
    ).toBe(true);
  });
  it('fault: expired transaction work awaits its original abort before rejecting', async () => {
    await fail(['find'], 9000);
    const result = await observeFault('work timeout and abort', () =>
      port.recordAuthorizedAction({ grant, authorizedAtMs: now - 1000 }),
    );
    expect(result.error?.name).toBe('MongoOperationTimeoutError');
    expect(result.value).toBeUndefined();
    expect(result.elapsedMs).toBeGreaterThanOrEqual(7500);
    expect(result.elapsedMs).toBeLessThan(17000);
    expect(
      result.commands.some(
        (command) => command.phase === 'succeeded' && command.name === 'abortTransaction',
      ),
    ).toBe(true);
    expect(result.server.receipts).toBe(0);
    expect(result.server.openTransactions).toBe(0);
  });
  it('fault: failed abort remains unknown even though the driver closes local transaction state', async () => {
    await mongoose.models.Session.updateOne(
      { _id: grant.sessionId },
      { $set: { idleExpiresAt: new Date(now - 1) } },
    );
    await fail(['abortTransaction'], 9000);
    const result = await observeFault('abort cleanup timeout', () =>
      port.recordAuthorizedAction({ grant, authorizedAtMs: now - 1000 }),
    );
    expect(result.error?.message).toBe('STATUS_USAGE_GRANT');
    expect(result.value).toBeUndefined();
    expect(result.elapsedMs).toBeGreaterThanOrEqual(7500);
    expect(result.elapsedMs).toBeLessThan(17000);
    expect(
      result.commands.some(
        (command) => command.phase === 'failed' && command.name === 'abortTransaction',
      ),
    ).toBe(true);
    expect(
      result.commands.some(
        (command) => command.phase === 'succeeded' && command.name === 'abortTransaction',
      ),
    ).toBe(false);
    expect(result.server.receipts).toBe(0);
    // The actual server still owns the transaction at this observation; local state is no retirement proof.
    expect(result.server.openTransactions).toBeGreaterThan(0);
  });
  it('fault: cursor cleanup is awaited and a failed read returns only unknown history', async () => {
    const end = Math.floor(now / 3600000) * 3600000;
    await mongoose.models.StatusUsageBucket.insertMany(
      Array.from({ length: 168 }, (_, i) => ({
        _id: `fault-history-${i}`,
        schemaVersion: 1,
        scopeId: 'cortex',
        tenantId: 'tenant',
        kind: 'hour',
        revision: 0,
        hourStartMs: end - (168 - i) * 3600000,
        active: 1,
        published: 1,
        expiresAt: new Date(now + 86400000),
      })),
    );
    await fail(['getMore', 'killCursors'], 3000, 'alwaysOn');
    const result = await observeFault('read timeout and cursor cleanup', () =>
      port.readCompletedHours(now),
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toHaveLength(168);
    expect(
      result.value!.every(
        (row) => row.activeUsers === null && row.publishedDocuments === null && !row.complete,
      ),
    ).toBe(true);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(3500);
    expect(result.elapsedMs).toBeLessThan(6500);
    expect(
      result.commands.some(
        (command) => command.phase === 'started' && command.name === 'killCursors',
      ),
    ).toBe(true);
    expect(
      result.commands.some(
        (command) => command.phase === 'failed' && command.name === 'killCursors',
      ),
    ).toBe(true);
  });
  it('fault: exhausted work and failed abort consume separate bounded budgets without returning a value', async () => {
    await fail(['find', 'abortTransaction'], 9000, 'alwaysOn');
    const result = await observeFault('combined work and abort timeout', () =>
      port.recordAuthorizedAction({ grant, authorizedAtMs: now - 1000 }),
    );
    expect(result.error?.name).toBe('MongoOperationTimeoutError');
    expect(result.value).toBeUndefined();
    expect(result.elapsedMs).toBeGreaterThanOrEqual(15000);
    expect(result.elapsedMs).toBeLessThan(18000);
    expect(
      result.commands.some((command) => command.phase === 'failed' && command.name === 'find'),
    ).toBe(true);
    expect(
      result.commands.some(
        (command) => command.phase === 'failed' && command.name === 'abortTransaction',
      ),
    ).toBe(true);
    expect(result.server.openTransactions).toBeGreaterThan(0);
    expect(result.server.receipts).toBe(0);
  });
});

describe('durable usage constructor validation', () => {
  const valid = { scopeId: 'cortex.application.usage.v1', tenantId: 'tenant-a' };
  const cases: [string, unknown][] = [
    ['missing options', undefined],
    ['null options', null],
    ['number options', 3],
    ['string options', 'scope'],
    ['boolean options', true],
    ['array options', []],
    ['function options', Object.assign(() => undefined, valid)],
    ['missing scope', { tenantId: 'tenant-a' }],
    ['missing tenant', { scopeId: 'scope' }],
    ...[
      undefined,
      null,
      3,
      true,
      [],
      {},
      new String('scope'),
      Symbol('scope'),
      'bad scope',
      '',
    ].map((value, i): [string, unknown] => ['invalid scope ' + i, { ...valid, scopeId: value }]),
    ...[
      undefined,
      3,
      true,
      [],
      {},
      new String('tenant-a'),
      Symbol('tenant'),
      '__SYSTEM__',
      'bad tenant',
      '',
    ].map((value, i): [string, unknown] => ['invalid tenant ' + i, { ...valid, tenantId: value }]),
    ...[null, 3, true, {}, [], 'clock'].map((value, i): [string, unknown] => [
      'invalid clock ' + i,
      { ...valid, clock: value },
    ]),
  ];
  test.each(cases)('%s fails before any model or database access', (_label, options) => {
    const access = jest.fn(() => {
      throw Error('UNEXPECTED_MODEL_ACCESS');
    });
    const blocked = new Proxy({}, { get: access }) as typeof mongoose;
    expect(() =>
      createStatusUsageMethods(blocked, options as Parameters<typeof createStatusUsageMethods>[1]),
    ).toThrow(/STATUS_USAGE_(OPTIONS|IDENTITY|TENANT|CLOCK)/);
    expect(access).not.toHaveBeenCalled();
  });
  test('does not coerce object scope or tenant values', () => {
    const coerce = jest.fn(() => 'tenant-a');
    const value = { toString: coerce, [Symbol.toPrimitive]: coerce };
    for (const options of [
      { ...valid, scopeId: value },
      { ...valid, tenantId: value },
    ])
      expect(() => createStatusUsageMethods({} as typeof mongoose, options as never)).toThrow(
        /STATUS_USAGE_/,
      );
    expect(coerce).not.toHaveBeenCalled();
  });
  test.each(['tenant-a', null])(
    'accepts explicit tenant %s without invoking clock or starting Mongo',
    (tenantId) => {
      const local = new mongoose.Mongoose();
      local.set('autoCreate', false);
      local.set('autoIndex', false);
      const clock = jest.fn(() => 0);
      const session = jest.spyOn(local, 'startSession');
      const port = createStatusUsageMethods(local, { ...valid, tenantId, clock });
      expect(typeof port.recordOriginalPublication).toBe('function');
      expect(local.models.StatusUsageReceipt).toBeDefined();
      expect(local.models.StatusUsageBucket).toBeDefined();
      expect(clock).not.toHaveBeenCalled();
      expect(session).not.toHaveBeenCalled();
      expect(local.connection.readyState).toBe(0);
    },
  );
});
