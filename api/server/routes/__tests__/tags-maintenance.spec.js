/** Actual tag router, access check, history owner and data methods; model originals stay in memory. */
const { EventEmitter } = require('node:events');
const { AsyncLocalStorage } = require('node:async_hooks');

let mockFixture;
jest.mock('~/models', () => mockFixture.methods);
jest.mock('@librechat/api', () => ({
  generateCheckAccess: jest.requireActual('../../../../packages/api/src/middleware/access.ts')
    .generateCheckAccess,
}));
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => {
    mockFixture.authCalls++;
    if (mockFixture.authGate) return mockFixture.authGate.promise.then(() => next());
    return next();
  },
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
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  throw new Error('Tag fixture did not reach the expected original operation');
}

function query(original) {
  return {
    sort() {
      return this;
    },
    lean() {
      return this;
    },
    then(resolve, reject) {
      return original.then(resolve, reject);
    },
  };
}

function createFixture() {
  const { createMethods, tenantStorage } = require('@librechat/data-schemas');
  const mongoose = require('mongoose');
  const requestContext = new AsyncLocalStorage();
  const trace = [];
  const methodCalls = [];
  const gates = new Map();
  const defaults = (name, args) => {
    const [filter, update] = args;
    if (name === 'ConversationTag.find') return [{ tag: 'old tag', user: filter.user }];
    if (name === 'ConversationTag.findOne') {
      if (mockFixture.missing || ['created', 'renamed'].includes(filter.tag)) return null;
      return { tag: filter.tag, position: 2 };
    }
    if (name === 'ConversationTag.findOneAndDelete')
      return mockFixture.missing ? null : { tag: filter.tag, position: 2 };
    if (name === 'ConversationTag.findOneAndUpdate')
      return { tag: update.tag ?? filter.tag, user: filter.user, position: update.position ?? 2 };
    if (name === 'Conversation.findOne') return { tags: ['old'] };
    if (name === 'Conversation.findOneAndUpdate')
      return { tags: update.$set?.tags ?? [update.$addToSet.tags] };
    return { acknowledged: true, modifiedCount: 1 };
  };
  const models = {};
  for (const [modelName, names] of [
    [
      'ConversationTag',
      ['find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'updateMany', 'bulkWrite'],
    ],
    ['Conversation', ['findOne', 'findOneAndUpdate', 'updateMany']],
  ]) {
    const model = { modelName };
    for (const name of names) {
      model[name] = jest.fn(function (...args) {
        const key = `${modelName}.${name}`;
        const row = {
          key,
          args,
          receiver: this,
          tenant: tenantStorage.getStore(),
          request: requestContext.getStore(),
        };
        trace.push(row);
        const gate = gates.get(`${key}:${args[0]?.user}`) ?? gates.get(key);
        const original = gate?.promise ?? Promise.resolve(defaults(key, args));
        return query(original);
      });
    }
    models[modelName] = model;
  }
  // The public method factory also validates these handles at construction. Their lazy
  // administration methods are outside this fixture and acquire no storage here.
  for (const name of ['PlatformAdminPolicy', 'SystemGrant', 'User', 'AuditLog']) {
    models[name] = Object.freeze({});
  }
  const database = Object.assign(Object.create(mongoose), { models });
  const actual = createMethods(database);
  const methods = {};
  for (const name of [
    'createConversationTag',
    'updateConversationTag',
    'deleteConversationTag',
    'updateTagsForConversation',
    'getConversationTags',
  ]) {
    methods[name] = jest.fn(function (...args) {
      methodCalls.push({ name, args, receiver: this });
      return Reflect.apply(actual[name], this, args);
    });
  }
  methods.getRoleByName = jest.fn(function (...args) {
    methodCalls.push({ name: 'getRoleByName', args, receiver: this });
    return (
      mockFixture.roleGate?.promise ??
      Promise.resolve({ permissions: { BOOKMARKS: { USE: true } } })
    );
  });
  return {
    methods,
    models,
    gates,
    trace,
    methodCalls,
    tenantStorage,
    requestContext,
    authCalls: 0,
    defaults,
  };
}

let router;
let owner;
const requests = [];

function dispatch(method, url, body = {}, userId = 'user-a', tenantId = 'tenant-a') {
  const req = Object.assign(new EventEmitter(), {
    method,
    url,
    originalUrl: `/api/tags${url}`,
    body,
    user: { id: userId, role: 'USER', tenantId },
    headers: {},
  });
  const complete = deferred();
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers: {},
    writableEnded: false,
    finished: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    json(body) {
      this.body = body;
      return this.end();
    },
    send(body) {
      this.body = body;
      return this.end();
    },
    end() {
      this.writableEnded = true;
      this.finished = true;
      this.emit('finish');
      complete.resolve();
      return this;
    },
  });
  const errors = [];
  const start = () =>
    mockFixture.tenantStorage.run({ tenantId, userId }, () =>
      mockFixture.requestContext.run({ userId, marker: `request:${userId}` }, () =>
        router.handle(req, res, (error) => {
          errors.push(error);
          res.status(error ? 500 : 404).end();
        }),
      ),
    );
  const request = { req, res, complete: complete.promise, errors, start };
  requests.push(request);
  start();
  return request;
}

beforeEach(() => {
  jest.resetModules();
  mockFixture = undefined;
  owner = undefined;
  mockFixture = createFixture();
  ({ historyMaintenance: owner } = require('~/server/services/HistoryMaintenance'));
  router = require('../tags');
});

afterEach(async () => {
  if (!mockFixture || !owner) return;
  mockFixture.authGate?.resolve();
  mockFixture.roleGate?.resolve({ permissions: { BOOKMARKS: { USE: true } } });
  for (const gate of mockFixture.gates.values()) gate.resolve({ modifiedCount: 1, tags: [] });
  for (const { res } of requests.splice(0)) res.emit('close');
  await owner.drain().catch(() => undefined);
});

const mutations = [
  {
    name: 'create and attach',
    method: 'POST',
    url: '/',
    body: { tag: 'created', addToConversation: true, conversationId: 'convo-a' },
    first: 'ConversationTag.findOneAndUpdate',
    last: 'Conversation.findOneAndUpdate',
    original: 'createConversationTag',
    args: ['user-a'],
    boundary: 'aborted',
  },
  {
    name: 'rename and reorder',
    method: 'PUT',
    url: '/old%20tag',
    body: { tag: 'renamed', position: 1 },
    first: 'Conversation.updateMany',
    last: 'ConversationTag.findOneAndUpdate',
    original: 'updateConversationTag',
    args: ['user-a', 'old tag'],
    boundary: 'close',
  },
  {
    name: 'delete and reorder',
    method: 'DELETE',
    url: '/old%20tag',
    body: {},
    first: 'ConversationTag.findOneAndDelete',
    last: 'ConversationTag.updateMany',
    original: 'deleteConversationTag',
    args: ['user-a', 'old tag'],
    boundary: 'finish',
  },
  {
    name: 'replace conversation tags',
    method: 'PUT',
    url: '/convo/convo-a',
    body: { tags: ['new'] },
    first: 'ConversationTag.bulkWrite',
    last: 'Conversation.findOneAndUpdate',
    original: 'updateTagsForConversation',
    args: ['user-a', 'convo-a'],
    boundary: 'close',
  },
];

test.each(mutations)(
  '$name retains both sequential originals after HTTP $boundary',
  async (scenario) => {
    const first = deferred();
    const last = deferred();
    mockFixture.gates.set(scenario.first, first);
    mockFixture.gates.set(scenario.last, last);
    const request = dispatch(scenario.method, scenario.url, scenario.body);
    await until(() => mockFixture.trace.some((row) => row.key === scenario.first));
    if (scenario.boundary === 'aborted') request.req.emit('aborted');
    else request.res.emit(scenario.boundary);
    owner.pauseAdmissions('tag-drain');
    let drained = false;
    const drain = owner.drain().then(() => {
      drained = true;
    });
    expect((await owner.getMaintenanceCensus('tag-drain')).pendingWrites).toBeGreaterThan(0);
    const firstCall = mockFixture.trace.find((row) => row.key === scenario.first);
    first.resolve(mockFixture.defaults(scenario.first, firstCall.args));
    await until(() => mockFixture.trace.some((row) => row.key === scenario.last));
    expect(drained).toBe(false);
    expect((await owner.getMaintenanceCensus('tag-drain')).pendingWrites).toBeGreaterThan(0);
    const lastCall = mockFixture.trace.find((row) => row.key === scenario.last);
    last.resolve(mockFixture.defaults(scenario.last, lastCall.args));
    await request.complete;
    await drain;
    expect(request.res.statusCode).toBe(200);
    expect(request.errors).toEqual([]);
    expect(await owner.getMaintenanceCensus('tag-drain')).toEqual({
      admissionClosed: true,
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
    const original = mockFixture.methodCalls.find((call) => call.name === scenario.original);
    const expectedArgs = [...scenario.args];
    if (scenario.method !== 'DELETE') expectedArgs.push(scenario.body.tags ?? scenario.body);
    expect(original.args).toEqual(expectedArgs);
    expect(original.receiver).toBe(mockFixture.methods);
    expect(mockFixture.trace.every((row) => row.tenant?.tenantId === 'tenant-a')).toBe(true);
    expect(mockFixture.trace.every((row) => row.request?.marker === 'request:user-a')).toBe(true);
    expect(
      mockFixture.trace.every((row) => row.receiver === mockFixture.models[row.key.split('.')[0]]),
    ).toBe(true);
  },
);

test.each(['authentication', 'bookmark access'])(
  'owns the preceding %s continuation across close and pause',
  async (stage) => {
    const gate = deferred();
    if (stage === 'authentication') mockFixture.authGate = gate;
    else mockFixture.roleGate = gate;
    const request = dispatch('POST', '/', { tag: 'created' });
    await until(() =>
      stage === 'authentication'
        ? mockFixture.authCalls === 1
        : mockFixture.methods.getRoleByName.mock.calls.length === 1,
    );
    request.res.emit('close');
    owner.pauseAdmissions('tag-drain');
    expect((await owner.getMaintenanceCensus('tag-drain')).pendingWrites).toBeGreaterThan(0);
    expect(mockFixture.trace).toHaveLength(0);
    gate.resolve({ permissions: { BOOKMARKS: { USE: true } } });
    await request.complete;
    await owner.drain();
    expect(request.res.statusCode).toBe(200);
    expect(mockFixture.methods.createConversationTag).toHaveBeenCalledWith('user-a', {
      tag: 'created',
    });
    expect((await owner.getMaintenanceCensus('tag-drain')).pendingWrites).toBe(0);
  },
);

test('one failed original does not release a sibling request or its tenant context', async () => {
  const failed = deferred();
  const sibling = deferred();
  mockFixture.gates.set('ConversationTag.findOneAndUpdate:user-a', failed);
  mockFixture.gates.set('ConversationTag.findOneAndUpdate:user-b', sibling);
  const first = dispatch('POST', '/', { tag: 'created' });
  const second = dispatch('POST', '/', { tag: 'created' }, 'user-b', 'tenant-b');
  await until(
    () =>
      mockFixture.trace.filter((row) => row.key === 'ConversationTag.findOneAndUpdate').length ===
      2,
  );
  first.res.emit('close');
  second.res.emit('close');
  owner.pauseAdmissions('tag-drain');
  failed.reject(new Error('original tag write rejected'));
  await first.complete;
  expect(first.res.statusCode).toBe(500);
  expect((await owner.getMaintenanceCensus('tag-drain')).pendingWrites).toBeGreaterThan(0);
  sibling.resolve({ tag: 'created', user: 'user-b' });
  await second.complete;
  await owner.drain();
  expect(second.res.statusCode).toBe(200);
  expect(
    mockFixture.trace
      .filter((row) => row.args[0]?.user === 'user-b')
      .every(
        (row) => row.tenant?.tenantId === 'tenant-b' && row.request?.marker === 'request:user-b',
      ),
  ).toBe(true);
});

test('closed admissions reject before authentication, access lookup or a model dispatch', async () => {
  owner.pauseAdmissions('tag-drain');
  const request = dispatch('POST', '/', { tag: 'created' });
  await request.complete;
  expect(request.res.statusCode).toBe(503);
  expect(request.res.body).toEqual({ error: 'APP_QUIESCING' });
  expect(request.res.headers['Retry-After']).toBe('1');
  expect(mockFixture.authCalls).toBe(0);
  expect(mockFixture.methodCalls).toHaveLength(0);
  expect(mockFixture.trace).toHaveLength(0);
});

test('a retired request cannot reopen custody and dispatch another mutation', async () => {
  const request = dispatch('POST', '/', { tag: 'created' });
  await request.complete;
  await until(() => mockFixture.methods.createConversationTag.mock.calls.length === 1);
  await new Promise(setImmediate);
  const calls = mockFixture.methodCalls.length;
  request.start();
  await until(() => request.errors.length === 1);
  expect(request.errors[0].message).toBe('HISTORY_SETTLEMENT_UNCONFIRMED');
  expect(mockFixture.methodCalls).toHaveLength(calls);
  owner.pauseAdmissions('tag-drain');
  expect((await owner.getMaintenanceCensus('tag-drain')).complete).toBe(false);
});

test.each(['PUT', 'DELETE'])(
  '%s preserves the missing-tag response without a subsequent write',
  async (method) => {
    mockFixture.missing = true;
    const request = dispatch(method, '/missing', { tag: 'renamed' });
    await request.complete;
    expect(request.res.statusCode).toBe(404);
    expect(request.res.body).toEqual({ error: 'Tag not found' });
    expect(
      mockFixture.trace.some((row) =>
        [
          'Conversation.updateMany',
          'ConversationTag.updateMany',
          'ConversationTag.findOneAndUpdate',
        ].includes(row.key),
      ),
    ).toBe(false);
  },
);

test('the ordinary read keeps its existing response and performs no mutation', async () => {
  const request = dispatch('GET', '/');
  await request.complete;
  expect(request.res.statusCode).toBe(200);
  expect(request.res.body).toEqual([{ tag: 'old tag', user: 'user-a' }]);
  expect(mockFixture.trace.map((row) => row.key)).toEqual(['ConversationTag.find']);
});
