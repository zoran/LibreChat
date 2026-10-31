/** Actual controller, ACL and raw-session originals; native server disposition remains separate. */
const { EventEmitter } = require('node:events');
const { AsyncLocalStorage } = require('node:async_hooks');

let mockFixture;
let mockConnection;
jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  const mongoose = Object.create(actual);
  Object.defineProperties(mongoose, {
    connection: { get: () => mockConnection ?? actual.connection },
    default: { value: mongoose },
  });
  return mongoose;
});
jest.mock('~/models', () => mockFixture.methods);
jest.mock('~/cache', () => ({ userPrincipalsCache: jest.fn() }));
jest.mock('~/config/winston', () => ({ debug: jest.fn(), error: jest.fn(), warn: jest.fn() }));
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  ...jest.requireActual('../../../../packages/data-schemas/src/utils/transactions'),
}));
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  ...jest.requireActual('../../../../packages/api/src/apiKeys/permissions.ts'),
  ...jest.requireActual('../../../../packages/api/src/acl/accessControlService'),
  ...jest.requireActual('../../../../packages/api/src/auth/maintenance'),
  mongoCacheMaintenance: jest.requireActual('../../../../packages/api/src/cache/keyvMongo')
    .mongoCacheMaintenance,
}));
jest.mock('~/server/services/GraphApiService', () => ({
  entraIdPrincipalFeatureEnabled: () => false,
  getGroupMembers: async () => [],
  getGroupOwners: async () => [],
}));
jest.mock('~/server/services/Config', () => ({
  invalidateCodeEnvironmentConfigCache: (...args) => mockFixture.invalidate(...args),
}));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function until(predicate) {
  for (let i = 0; i < 40; i++) {
    if (await predicate()) return;
    await new Promise(setImmediate);
  }
  throw new Error('Permission fixture did not reach the expected original');
}

function query(original) {
  const result = { then: (yes, no) => original.then(yes, no), exec: () => original };
  for (const name of ['lean', 'sort', 'select', 'session', 'read', 'limit']) {
    result[name] = () => result;
  }
  return result;
}

function sessionFor(client) {
  let active = false;
  return Object.assign(new EventEmitter(), {
    client,
    hasEnded: false,
    timeoutMS: undefined,
    withTransaction: jest.fn(async function (callback) {
      this.startTransaction();
      try {
        const result = await callback(this);
        await this.commitTransaction();
        return result;
      } catch (error) {
        if (this.inTransaction()) await this.abortTransaction();
        throw error;
      }
    }),
    startTransaction: jest.fn(() => {
      active = true;
    }),
    inTransaction: jest.fn(() => active),
    commitTransaction: jest.fn(async () => {
      active = false;
    }),
    abortTransaction: jest.fn(async () => {
      active = false;
    }),
    endSession: jest.fn(async function () {
      this.hasEnded = true;
      active = false;
      this.emit('ended');
    }),
  });
}

function createFixture() {
  const { createMethods, tenantStorage } = require('@librechat/data-schemas');
  const {
    ResourceType,
    PrincipalType,
    AccessRoleIds,
    PermissionBits,
  } = require('librechat-data-provider');
  const mongoose = require('mongoose');
  const client = {};
  const rawCollection = { findOne: jest.fn(async () => null) };
  const connection = {
    getClient: () => client,
    db: { collection: jest.fn(() => rawCollection) },
    startSession: jest.fn(async () => sessionFor(client)),
  };
  const requestContext = new AsyncLocalStorage();
  const id = '507f1f77bcf86cd799439011';
  const userId = '507f1f77bcf86cd799439012';
  const roles = [
    {
      _id: new mongoose.Types.ObjectId(),
      accessRoleId: AccessRoleIds.REMOTE_AGENT_OWNER,
      resourceType: ResourceType.REMOTE_AGENT,
      permBits: PermissionBits.VIEW | PermissionBits.SHARE,
    },
    {
      _id: new mongoose.Types.ObjectId(),
      accessRoleId: AccessRoleIds.AGENT_VIEWER,
      resourceType: ResourceType.AGENT,
      permBits: PermissionBits.VIEW,
    },
  ];
  const trace = [];
  const gates = new Map();
  const pending = [];
  const counts = new Map();
  const defaults = (key, args) => {
    if (key === 'AccessRole.find') return roles;
    if (key === 'AccessRole.findOne') return roles[0];
    if (key === 'AclEntry.find') return [];
    if (key === 'AclEntry.aggregate') {
      const resourceType = args[0][0].$match.resourceType;
      if (resourceType !== ResourceType.AGENT) return [];
      return [
        {
          principalId: new mongoose.Types.ObjectId(userId),
          userInfo: {
            _id: new mongoose.Types.ObjectId(userId),
            tenantId: requestContext.getStore().tenantId,
            name: 'Owner',
          },
        },
      ];
    }
    if (key === 'Agent.findOne')
      return { _id: id, id: 'agent-public-id', tenantId: requestContext.getStore().tenantId };
    if (key === 'AclEntry.bulkWrite') return { acknowledged: true, upsertedIds: {} };
    if (key === 'User.findOne' || key === 'Group.findOne') return null;
    if (key === 'User.create') return { _id: new mongoose.Types.ObjectId(userId) };
    if (key === 'Group.create') return [{ _id: new mongoose.Types.ObjectId(id), ...args[0][0] }];
    return { acknowledged: true, deletedCount: 1, modifiedCount: 1 };
  };
  const models = {};
  for (const [modelName, names] of [
    ['AclEntry', ['aggregate', 'find', 'deleteMany', 'bulkWrite']],
    ['AccessRole', ['find', 'findOne']],
    ['Agent', ['findOne']],
    ['User', ['findOne', 'create', 'updateMany']],
    ['Group', ['findOne', 'create', 'findByIdAndUpdate']],
  ]) {
    const model = { modelName };
    for (const name of names) {
      model[name] = jest.fn(function (...args) {
        const key = `${modelName}.${name}`;
        const ordinal = (counts.get(key) ?? 0) + 1;
        counts.set(key, ordinal);
        trace.push({
          key,
          ordinal,
          args,
          receiver: this,
          tenant: tenantStorage.getStore(),
          request: requestContext.getStore(),
        });
        const gate = gates.get(`${key}:${ordinal}`) ?? gates.get(key);
        return query(gate?.promise ?? Promise.resolve(defaults(key, args)));
      });
    }
    models[modelName] = model;
  }
  for (const name of ['PlatformAdminPolicy', 'SystemGrant', 'AuditLog']) models[name] = {};
  const database = Object.assign(Object.create(mongoose), { models });
  const actual = createMethods(database);
  const calls = [];
  const methods = {};
  for (const [name, method] of Object.entries(actual)) {
    methods[name] =
      typeof method !== 'function'
        ? method
        : function (...args) {
            calls.push({ name, args, receiver: this });
            return Reflect.apply(method, this, args);
          };
  }
  // Audit persistence/index qualification is separate; retain this actual boundary promise/null result.
  methods.recordAuditEntry = jest.fn(function (...args) {
    calls.push({ name: 'recordAuditEntry', args, receiver: this });
    return mockFixture.audit?.promise ?? Promise.resolve(mockFixture.auditNull ? null : {});
  });
  return {
    client,
    connection,
    rawCollection,
    models,
    methods,
    trace,
    calls,
    gates,
    pending,
    defaults,
    roles,
    id,
    userId,
    ResourceType,
    PrincipalType,
    AccessRoleIds,
    tenantStorage,
    requestContext,
    invalidate: jest.fn(() => mockFixture.config?.promise ?? Promise.resolve()),
    hold(key) {
      const gate = deferred();
      gates.set(key, gate);
      pending.push(gate);
      return gate;
    },
  };
}

let owner;
let controllers;
const running = [];

function dispatch(kind, { tenantId = 'tenant-a', resourceType, body } = {}) {
  const f = mockFixture;
  const req = Object.assign(new EventEmitter(), {
    params: { resourceType: resourceType ?? f.ResourceType.REMOTE_AGENT, resourceId: f.id },
    body: body ?? { updated: [], removed: [] },
    user: { id: f.userId, role: 'ADMIN', tenantId },
    headers: {},
  });
  const res = Object.assign(new EventEmitter(), {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      this.emit('finish');
      return this;
    },
  });
  const original = f.tenantStorage.run({ tenantId, userId: f.userId }, () =>
    f.requestContext.run({ tenantId, request: `${kind}-${tenantId}` }, () =>
      controllers[kind].call({ routeReceiver: kind }, req, res),
    ),
  );
  const promise = Promise.resolve(original);
  running.push(promise);
  return { req, res, promise };
}

beforeEach(() => {
  mockConnection = undefined;
  jest.resetModules();
  delete process.env.AUDIT_LOG_FAIL_CLOSED;
  mockFixture = createFixture();
  controllers = require('../PermissionsController');
  owner = require('~/server/services/PermissionService').permissionMaintenance;
  // Compile disconnected models before the raw driver boundary takes ownership.
  mockConnection = mockFixture.connection;
});

afterEach(async () => {
  if (!mockFixture) return;
  for (const gate of mockFixture.pending) gate.resolve({ acknowledged: true, upsertedIds: {} });
  mockFixture.audit?.resolve({});
  mockFixture.config?.resolve();
  await Promise.allSettled(running.splice(0));
  await new Promise(setImmediate);
  await owner?.drain().catch(() => {});
  delete process.env.AUDIT_LOG_FAIL_CLOSED;
});

test.each(['finish', 'close', 'aborted'])(
  'GET retains lookup and backfill after HTTP %s',
  async (event) => {
    const f = mockFixture;
    const lookup = f.hold('AccessRole.find');
    const write = f.hold('AclEntry.bulkWrite');
    const request = dispatch('getResourcePermissions');
    await request.promise;
    expect(request.res.statusCode).toBe(200);
    (event === 'aborted' ? request.req : request.res).emit(event);
    owner.pauseAdmissions('hold');
    expect((await owner.getMaintenanceCensus('hold')).queuedContinuations).toBe(1);
    let settled = false;
    const drain = owner.drain().then(() => {
      settled = true;
    });
    lookup.resolve(f.roles);
    await until(() => f.trace.some((row) => row.key === 'AclEntry.bulkWrite'));
    expect(settled).toBe(false);
    expect((await owner.getMaintenanceCensus('hold')).pendingWrites).toBe(1);
    const call = f.trace.find((row) => row.key === 'AclEntry.bulkWrite');
    expect(call.receiver).toBe(f.models.AclEntry);
    expect(call.tenant).toMatchObject({ tenantId: 'tenant-a' });
    expect(call.request).toEqual({
      tenantId: 'tenant-a',
      request: 'getResourcePermissions-tenant-a',
    });
    expect(call.args[1]).toEqual({ ordered: false });
    expect(call.args[0][0].updateOne.filter).toMatchObject({
      resourceType: f.ResourceType.REMOTE_AGENT,
      tenantId: 'tenant-a',
    });
    write.resolve({ acknowledged: true });
    await drain;
    expect(await owner.getMaintenanceCensus('hold')).toEqual({
      admissionClosed: true,
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
  },
);

test('PUT returns success while retaining the favorites lookup and update originals', async () => {
  const f = mockFixture;
  const lookup = f.hold('Agent.findOne');
  const write = f.hold('User.updateMany');
  const request = dispatch('updateResourcePermissions', {
    body: { updated: [], removed: [{ type: f.PrincipalType.USER, id: f.userId }] },
  });
  await request.promise;
  expect(request.res.statusCode).toBe(200);
  request.res.emit('close');
  owner.pauseAdmissions('hold');
  expect((await owner.getMaintenanceCensus('hold')).pendingWrites).toBe(1);
  let settled = false;
  const drain = owner.drain().then(() => {
    settled = true;
  });
  lookup.resolve({ id: 'agent-public-id', tenantId: 'tenant-a' });
  await until(() => f.trace.some((row) => row.key === 'User.updateMany'));
  expect(settled).toBe(false);
  const call = f.trace.find((row) => row.key === 'User.updateMany');
  expect(call.receiver).toBe(f.models.User);
  expect(call.args).toEqual([
    { _id: { $in: [f.userId] }, tenantId: 'tenant-a', 'favorites.agentId': 'agent-public-id' },
    { $pull: { favorites: { agentId: 'agent-public-id' } } },
  ]);
  expect(call.request.tenantId).toBe('tenant-a');
  write.resolve({ acknowledged: true, modifiedCount: 1 });
  await drain;
});

test('a failed backfill keeps a sibling original and its tenant context owned', async () => {
  const f = mockFixture;
  const first = f.hold('AclEntry.bulkWrite:1');
  const second = f.hold('AclEntry.bulkWrite:2');
  const a = dispatch('getResourcePermissions');
  const b = dispatch('getResourcePermissions', { tenantId: 'tenant-b' });
  await Promise.all([a.promise, b.promise]);
  await until(() => f.trace.filter((row) => row.key === 'AclEntry.bulkWrite').length === 2);
  owner.pauseAdmissions('hold');
  first.reject(new Error('unknown first write'));
  await until(() => f.trace.filter((row) => row.key === 'AclEntry.bulkWrite').length === 2);
  await new Promise(setImmediate);
  expect(await owner.getMaintenanceCensus('hold')).toMatchObject({
    queuedContinuations: 1,
    pendingWrites: 1,
    complete: false,
  });
  let settled = false;
  const drain = owner.drain().catch((error) => {
    settled = true;
    return error;
  });
  await new Promise(setImmediate);
  expect(settled).toBe(false);
  const call = f.trace.find((row) => row.key === 'AclEntry.bulkWrite' && row.ordinal === 2);
  expect(call.tenant.tenantId).toBe('tenant-b');
  expect(call.request.tenantId).toBe('tenant-b');
  second.resolve({ acknowledged: true });
  expect((await drain).message).toBe('PERMISSION_SETTLEMENT_UNCONFIRMED');
  expect(owner.resumeAdmissions('hold')).toBe(false);
});

function insightsRequest() {
  const f = mockFixture;
  return dispatch('updateResourcePermissions', {
    resourceType: f.ResourceType.AGENT,
    body: {
      updated: [
        {
          type: f.PrincipalType.ROLE,
          id: 'USER',
          accessRoleId: f.AccessRoleIds.AGENT_VIEWER,
          viewInsights: true,
        },
      ],
      removed: [],
    },
  });
}

test('audit rejection retains the real compensation original before returning the existing error', async () => {
  const f = mockFixture;
  process.env.AUDIT_LOG_FAIL_CLOSED = 'true';
  f.audit = deferred();
  const compensation = f.hold('AclEntry.bulkWrite:2');
  const request = insightsRequest();
  await until(() => f.methods.recordAuditEntry.mock.calls.length === 1);
  owner.pauseAdmissions('hold');
  request.res.emit('close');
  f.audit.reject(new Error('audit unavailable'));
  await until(() => f.trace.some((row) => row.key === 'AclEntry.bulkWrite' && row.ordinal === 2));
  expect(request.res.statusCode).toBeUndefined();
  expect(await owner.getMaintenanceCensus('hold')).toMatchObject({
    pendingWrites: 2,
    complete: false,
  });
  compensation.resolve({ acknowledged: true });
  await request.promise;
  expect(request.res.statusCode).toBe(500);
  await expect(owner.drain()).rejects.toThrow('PERMISSION_SETTLEMENT_UNCONFIRMED');
});

test('a normalized null audit result preserves success and leaves maintenance uncertain', async () => {
  mockFixture.auditNull = true;
  const request = insightsRequest();
  await request.promise;
  expect(request.res.statusCode).toBe(200);
  owner.pauseAdmissions('hold');
  expect((await owner.getMaintenanceCensus('hold')).complete).toBe(false);
  await expect(owner.drain()).rejects.toThrow('PERMISSION_SETTLEMENT_UNCONFIRMED');
});

test('code-environment invalidation stays owned through HTTP close and normalized failure', async () => {
  const f = mockFixture;
  f.config = deferred();
  const request = dispatch('updateResourcePermissions', {
    resourceType: f.ResourceType.CODE_ENVIRONMENT,
  });
  await until(() => f.invalidate.mock.calls.length === 1);
  owner.pauseAdmissions('hold');
  request.res.emit('close');
  expect((await owner.getMaintenanceCensus('hold')).pendingWrites).toBe(1);
  expect(f.invalidate).toHaveBeenCalledWith('tenant-a');
  f.config.reject(new Error('cache unavailable'));
  await request.promise;
  expect(request.res.statusCode).toBe(200);
  await expect(owner.drain()).rejects.toThrow('PERMISSION_SETTLEMENT_UNCONFIRMED');
});

test('closed admission refuses both controller entries before data dispatch', async () => {
  owner.pauseAdmissions('hold');
  for (const name of ['getResourcePermissions', 'updateResourcePermissions']) {
    const request = dispatch(name);
    await request.promise;
    expect(request.res.statusCode).toBe(503);
    expect(request.res.headers['Retry-After']).toBe('1');
    expect(controllers[name]).toHaveLength(2);
  }
  expect(mockFixture.trace).toHaveLength(0);
});

test('a retired continuation cannot dispatch or clear its uncertainty', async () => {
  let captured;
  await owner.run((operation) => {
    captured = operation;
  });
  const dispatchWrite = jest.fn();
  expect(() => captured.write(dispatchWrite)).toThrow('after settlement');
  expect(dispatchWrite).not.toHaveBeenCalled();
  owner.pauseAdmissions('hold');
  expect((await owner.getMaintenanceCensus('hold')).complete).toBe(false);
  expect(owner.resumeAdmissions('hold')).toBe(false);
});

test('principal preparation preserves existing method arity and captures its original user creation', async () => {
  const f = mockFixture;
  const service = require('~/server/services/PermissionService');
  expect(service.ensurePrincipalExists).toHaveLength(1);
  expect(service.ensureGroupPrincipalExists).toHaveLength(1);
  const write = f.hold('User.create');
  const request = dispatch('updateResourcePermissions', {
    body: {
      updated: [
        {
          type: f.PrincipalType.USER,
          source: 'entra',
          idOnTheSource: 'directory-user',
          email: 'user@example.test',
          name: 'User',
          accessRoleId: f.AccessRoleIds.REMOTE_AGENT_OWNER,
        },
      ],
      removed: [],
    },
  });
  await until(() => f.trace.some((row) => row.key === 'User.create'));
  owner.pauseAdmissions('hold');
  request.res.emit('close');
  expect((await owner.getMaintenanceCensus('hold')).pendingWrites).toBe(1);
  const call = f.calls.find((row) => row.name === 'createUser');
  expect(call.receiver).toBe(f.methods);
  expect(call.args.slice(1)).toEqual([true, true]);
  write.resolve({ _id: require('mongoose').Types.ObjectId.createFromHexString(f.userId) });
  await request.promise;
  expect(request.res.statusCode).toBe(200);
  await owner.drain();
});

function permissionApp() {
  const { createAppMaintenance } = jest.requireActual(
    '../../../../packages/api/src/app/maintenance',
  );
  const remaining = [
    'raw database commands, sessions and independent writers outside qualified owners',
    'standalone tag/share and other HTTP mutations',
    'MCP/OAuth reconnect, search indexing, code lifecycle and remaining background owners',
  ];
  const census = {
    admissionClosed: false,
    initializing: 0,
    providerExecutions: 0,
    queuedContinuations: 0,
    pendingWrites: 0,
    activeStreams: 0,
    unresolved: 0,
    complete: true,
  };
  const app = createAppMaintenance({
    readStorageProviders: () => ({
      ordinaryS3: { state: 'not-owned' },
      managedS3: { state: 'not-owned' },
    }),
    env: {
      LIBRECHAT_MAINTENANCE_TOKEN: 'a'.repeat(32),
      POD_UID: '12345678-1234-1234-1234-123456789012',
      BUILD_COMMIT: 'a'.repeat(40),
    },
    requiredSharedState: false,
    startupReady: () => true,
    probeDatabase: async () => true,
    probeSharedState: async () => true,
    workOwners: { permissions: owner },
    fileDomainOwners: [],
    unqualifiedOwners: remaining,
    generation: {
      closeGenerationAdmission: () => {
        census.admissionClosed = true;
        return true;
      },
      reopenGenerationAdmission: () => {
        census.admissionClosed = false;
        return true;
      },
      getGenerationAdmissionCensus: async () => ({ ...census }),
      getGenerationRuntimeHealth: async () => true,
    },
  });
  const request = (expectedRevision) => ({
    identity: app.identity,
    requestId: 'raw-hold',
    expectedRevision,
  });
  return { app, request, remaining };
}

test.each(['settled', 'unknown'])(
  'raw-session App join retains controller originals with %s cleanup',
  async (outcome) => {
    const f = mockFixture;
    const favorites = outcome === 'settled' ? f.hold('User.updateMany') : undefined;
    const probe = sessionFor(f.client);
    const mutation = sessionFor(f.client);
    const mutationCommit = mutation.commitTransaction;
    f.connection.startSession.mockReset().mockResolvedValueOnce(probe).mockResolvedValue(mutation);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    f.pending.push(...gates);
    for (const [index, [session, method]] of [
      [probe, 'commitTransaction'],
      [probe, 'endSession'],
      [mutation, 'commitTransaction'],
      [mutation, 'endSession'],
    ].entries()) {
      const original = session[method].getMockImplementation();
      session[method].mockImplementation(async function (...args) {
        await gates[index].promise;
        return Reflect.apply(original, this, args);
      });
    }
    const { app, request, remaining } = permissionApp();
    const original = dispatch('updateResourcePermissions', {
      body: { updated: [], removed: [{ type: f.PrincipalType.USER, id: f.userId }] },
    });
    try {
      await until(() => probe.commitTransaction.mock.calls.length === 1);
      expect(f.connection.db.collection).toHaveBeenCalledWith('__transaction_test__');
      expect(f.rawCollection.findOne).toHaveBeenCalledWith({}, { session: probe });
      expect(app.operation('begin', request(0))).toBe(200);
      original.res.emit('close');
      const refused = dispatch('updateResourcePermissions');
      await refused.promise;
      expect(refused.res.statusCode).toBe(503);
      expect(f.connection.startSession).toHaveBeenCalledTimes(1);
      expect((await owner.getMaintenanceCensus('raw-hold')).queuedContinuations).toBe(1);
      expect((await app.externalCensus()).pendingWrites).toBeGreaterThan(0);
      gates[0].resolve();
      await until(() => probe.endSession.mock.calls.length === 1);
      expect(original.res.statusCode).toBeUndefined();
      expect(f.connection.startSession).toHaveBeenCalledTimes(1);
      expect(await owner.getMaintenanceCensus('raw-hold')).toMatchObject({
        queuedContinuations: 1,
        pendingWrites: 1,
      });
      gates[1].resolve();
      await until(() => mutationCommit.mock.calls.length === 1);
      expect(f.connection.startSession).toHaveBeenCalledTimes(2);
      const deletion = f.trace.find((row) => row.key === 'AclEntry.deleteMany');
      expect(deletion.receiver).toBe(f.models.AclEntry);
      expect(deletion.args[1]).toEqual({ session: mutation });
      expect(deletion.tenant).toMatchObject({ tenantId: 'tenant-a' });
      expect(deletion.request).toEqual({
        tenantId: 'tenant-a',
        request: 'updateResourcePermissions-tenant-a',
      });
      expect((await app.externalCensus()).pendingWrites).toBeGreaterThan(0);
      gates[2].resolve();
      await until(() => mutation.endSession.mock.calls.length === 1);
      expect(original.res.statusCode).toBeUndefined();
      expect(await owner.getMaintenanceCensus('raw-hold')).toMatchObject({
        queuedContinuations: 1,
        pendingWrites: 1,
      });
      expect(mutationCommit.mock.contexts[0]).toBe(mutation);
      expect(mutation.endSession.mock.contexts[0]).toBe(mutation);
      if (outcome === 'unknown') gates[3].reject(new Error('session cleanup unknown'));
      else gates[3].resolve();
      await original.promise;
      expect(original.res.statusCode).toBe(outcome === 'unknown' ? 400 : 200);
      if (favorites) {
        await until(() => f.models.User.updateMany.mock.calls.length === 1);
        expect(await owner.getMaintenanceCensus('raw-hold')).toMatchObject({
          queuedContinuations: 1,
          pendingWrites: 1,
          complete: true,
        });
        favorites.resolve({ acknowledged: true, modifiedCount: 1 });
        await until(async () => {
          const census = await owner.getMaintenanceCensus('raw-hold');
          return census.queuedContinuations === 0 && census.pendingWrites === 0;
        });
      } else {
        expect(original.res.body.details).toBe('session cleanup unknown');
        expect(f.models.User.updateMany).not.toHaveBeenCalled();
      }
      expect(await owner.getMaintenanceCensus('raw-hold')).toMatchObject({
        queuedContinuations: 0,
        pendingWrites: 0,
        complete: outcome === 'settled',
      });
      expect(app.operation('cancel', request(1))).toBe(outcome === 'unknown' ? 503 : 200);
      expect(await app.status()).toMatchObject({
        known: false,
        blockingReasons: expect.arrayContaining(remaining),
      });
      expect(f.connection.startSession).toHaveBeenCalledTimes(2);
      expect(probe.endSession).toHaveBeenCalledTimes(1);
      expect(mutation.endSession).toHaveBeenCalledTimes(1);
      expect(mutation.abortTransaction).not.toHaveBeenCalled();
    } finally {
      for (const gate of gates) gate.resolve();
      await original.promise;
    }
  },
);
