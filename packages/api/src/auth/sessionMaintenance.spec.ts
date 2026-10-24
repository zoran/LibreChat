import { Socket } from 'node:net';
import session from 'express-session';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { IncomingMessage, ServerResponse } from 'node:http';
import { createAuthSessionStore } from './sessionMaintenance';
import { createAuthMaintenance } from './maintenance';

const signature = jest.requireActual<{
  sign(value: string, secret: string): string;
}>('cookie-signature');

test('installed express-session final save retains the root after controller return', async () => {
  const owner = createAuthMaintenance();
  const store = new session.MemoryStore();
  let save!: (error?: unknown) => void;
  store.set = jest.fn((_sid, _data, callback) => {
    save = callback!;
  });
  const req = new IncomingMessage(new Socket()) as IncomingMessage & {
    session: session.Session & { test?: boolean };
  };
  req.url = '/auth';
  const res = new ServerResponse(req);
  const ended = jest.fn(() => res);
  res.end = ended;
  const middleware = session({
    secret: 'test-session-secret',
    resave: false,
    saveUninitialized: false,
    store: createAuthSessionStore(store, owner),
  });
  await new Promise<void>((resolve, reject) => {
    owner.admissionMiddleware(req as never, res as never, () => {
      middleware(req as never, res as never, (error) => (error ? reject(error) : resolve()));
    });
  });
  // Run in the accepted context, as an actual controller invoked by session next() would.
  await owner.run(req, async () => {
    req.session.test = true;
    res.end();
  });
  owner.pauseAdmissions('drain');
  expect(store.set).toHaveBeenCalledTimes(1);
  expect(ended).not.toHaveBeenCalled();
  expect(await owner.getMaintenanceCensus('drain')).toMatchObject({
    queuedContinuations: 1,
    pendingWrites: 1,
  });
  save();
  await new Promise((resolve) => setImmediate(resolve));
  expect(ended).toHaveBeenCalledTimes(1);
  expect(await owner.getMaintenanceCensus('drain')).toMatchObject({
    queuedContinuations: 0,
    pendingWrites: 0,
    complete: true,
  });
  req.socket.destroy();
});

test('store rejection and missing request ownership never look complete', async () => {
  const owner = createAuthMaintenance();
  const store = new session.MemoryStore();
  store.destroy = jest.fn((_sid, callback) => callback?.(new Error('unknown delete')));
  const observed = createAuthSessionStore(store, owner);
  await new Promise<void>((resolve) =>
    observed.destroy('not-recorded-in-census', (error) => {
      expect(error).toBeInstanceOf(Error);
      resolve();
    }),
  );
  owner.pauseAdmissions('drain');
  expect((await owner.getMaintenanceCensus('drain')).complete).toBe(false);
});

test('a store callback restores its accepted context and retains child writes after response end', async () => {
  const owner = createAuthMaintenance();
  const store = new session.MemoryStore();
  let saved!: (error?: unknown) => void;
  let finishChild!: () => void;
  const child = new Promise<void>((resolve) => {
    finishChild = resolve;
  });
  store.set = jest.fn((_sid, _data, done) => {
    saved = done!;
  });
  const observed = createAuthSessionStore(store, owner);
  const req = {};
  const res = Object.assign(new EventEmitter(), { end: jest.fn() });
  let childWork!: Promise<void>;
  const delivered = jest.fn(() => {
    expect(owner.current()).toBe(owner.forRequest(req));
    childWork = owner.current()!.write(() => child);
  });
  owner.admissionMiddleware(req as never, res as never, () => {
    observed.set('fixture', {} as session.SessionData, delivered);
  });
  res.end();
  owner.pauseAdmissions('drain');
  // Invoke outside the context in which the store registered the callback, as a shared pool may.
  saved();
  saved();
  expect(delivered).toHaveBeenCalledTimes(1);
  await new Promise((resolve) => setImmediate(resolve));
  expect(await owner.getMaintenanceCensus('drain')).toMatchObject({
    queuedContinuations: 1,
    pendingWrites: 1,
    complete: true,
  });
  finishChild();
  await childWork;
  expect(await owner.getMaintenanceCensus('drain')).toMatchObject({
    queuedContinuations: 0,
    pendingWrites: 0,
    complete: true,
  });
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('real express-session get and final save retain originals and request context after close', async () => {
  const owner = createAuthMaintenance();
  const requestContext = new AsyncLocalStorage<string>();
  const store = new session.MemoryStore();
  await new Promise<void>((resolve) =>
    store.set(
      'existing',
      {
        cookie: {
          expires: new Date(Date.now() + 60000),
          originalMaxAge: 60000,
          httpOnly: true,
          path: '/',
        },
      } as session.SessionData,
      () => resolve(),
    ),
  );
  const get = store.get;
  let completeGet!: () => void;
  let returnGet!: () => void;
  const getOriginal = new Promise<void>((resolve) => {
    returnGet = resolve;
  });
  store.get = jest.fn(function (this: session.Store, sid, done) {
    expect(this).toBe(store);
    completeGet = () => get.call(this, sid, done);
    return getOriginal;
  });
  let completeSet!: (error?: unknown) => void;
  let returnSet!: () => void;
  const setOriginal = new Promise<void>((resolve) => {
    returnSet = resolve;
  });
  store.set = jest.fn(function (this: session.Store, _sid, _data, done) {
    expect(this).toBe(store);
    expect(requestContext.getStore()).toBe('request-tenant');
    completeSet = done!;
    return setOriginal;
  });
  const req = new IncomingMessage(new Socket()) as IncomingMessage & {
    session: session.Session & { changed?: boolean };
  };
  req.url = '/auth';
  req.headers.cookie =
    'connect.sid=' + encodeURIComponent('s:' + signature.sign('existing', 'fixture-secret'));
  const res = new ServerResponse(req);
  const ended = jest.fn(() => res);
  res.end = ended;
  const middleware = session({
    secret: 'fixture-secret',
    resave: false,
    saveUninitialized: false,
    store: createAuthSessionStore(store, owner),
  });
  const next = jest.fn((error?: unknown) => {
    expect(error).toBeUndefined();
    expect(requestContext.getStore()).toBe('request-tenant');
    expect(owner.current()).toBe(owner.forRequest(req));
    req.session.changed = true;
    res.end();
  });
  requestContext.run('request-tenant', () =>
    owner.admissionMiddleware(req as never, res as never, () => {
      middleware(req as never, res as never, next);
    }),
  );
  res.emit('close');
  owner.pauseAdmissions('session-read');
  let settled = false;
  const drain = owner.drain().then(() => {
    settled = true;
  });
  try {
    expect(await owner.getMaintenanceCensus('session-read')).toMatchObject({
      queuedContinuations: 1,
      pendingWrites: 0,
    });
    completeGet();
    await tick();
    expect(next).toHaveBeenCalledTimes(1);
    expect(store.set).toHaveBeenCalledTimes(1);
    completeSet();
    await tick();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    returnGet();
    await tick();
    expect(settled).toBe(false);
    returnSet();
    await drain;
    expect(await owner.getMaintenanceCensus('session-read')).toMatchObject({
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
  } finally {
    returnGet();
    returnSet();
    req.socket.destroy();
  }
});

test.each([
  { name: 'get', args: ['fixture'] },
  { name: 'set', args: ['fixture', {}] },
  { name: 'destroy', args: ['fixture'] },
  { name: 'touch', args: ['fixture', {}] },
  { name: 'clear', args: [] },
  { name: 'all', args: [] },
  { name: 'length', args: [] },
])('missing ownership refuses $name before the original store is touched', ({ name, args }) => {
  const owner = createAuthMaintenance();
  const store = new session.MemoryStore();
  const original = jest.fn();
  Object.defineProperty(store, name, { value: original });
  const observed = createAuthSessionStore(store, owner) as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const complete = jest.fn();
  observed[name](...args, complete);
  expect(original).not.toHaveBeenCalled();
  expect(complete).toHaveBeenCalledTimes(1);
  expect(complete.mock.calls[0][0].message).toBe('AUTH_SESSION_OWNERSHIP_REQUIRED');
});

test('a retired callback context cannot dispatch a store write even after admission reopens', async () => {
  const owner = createAuthMaintenance();
  const store = new session.MemoryStore();
  store.destroy = jest.fn();
  const observed = createAuthSessionStore(store, owner);
  let restore!: ReturnType<typeof AsyncLocalStorage.snapshot>;
  await owner.run(undefined, () => {
    restore = AsyncLocalStorage.snapshot();
  });
  const callback = jest.fn();
  restore(() => observed.destroy('retired', callback));
  await tick();
  expect(store.destroy).not.toHaveBeenCalled();
  expect(callback).toHaveBeenCalledTimes(1);
  owner.pauseAdmissions('retired');
  expect((await owner.getMaintenanceCensus('retired')).complete).toBe(false);
});

test.each([false, true])(
  'store returned rejection retains its actual callback and classifies write=%s',
  async (write) => {
    const owner = createAuthMaintenance();
    const store = new session.MemoryStore();
    const failure = new Error('returned original failed');
    let rejectOriginal!: (error: unknown) => void;
    const original = new Promise<void>((_resolve, reject) => {
      rejectOriginal = reject;
    });
    let complete!: (error?: unknown) => void;
    const name = write ? 'destroy' : 'get';
    store[name] = jest.fn((_sid, done) => {
      if (typeof done !== 'function') throw new Error('Store fixture requires its callback');
      complete = done;
      return original;
    });
    const observed = createAuthSessionStore(store, owner);
    const callback = jest.fn();
    await owner.run(undefined, () => {
      expect(observed[name]('fixture', callback)).toBe(original);
    });
    owner.pauseAdmissions('rejected-store');
    rejectOriginal(failure);
    await tick();
    expect(callback).not.toHaveBeenCalled();
    expect(await owner.getMaintenanceCensus('rejected-store')).toMatchObject({
      queuedContinuations: 1,
      pendingWrites: write ? 1 : 0,
      complete: !write,
    });
    let drained = false;
    const drain = owner.drain().then(
      () => {
        drained = true;
      },
      (error) => {
        drained = true;
        return error;
      },
    );
    await tick();
    expect(drained).toBe(false);
    complete(failure);
    await tick();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(failure);
    expect(await owner.getMaintenanceCensus('rejected-store')).toMatchObject({
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: !write,
    });
    if (write) expect((await drain).message).toBe('AUTH_SETTLEMENT_UNCONFIRMED');
    else expect(await drain).toBeUndefined();
  },
);

test('optional method arity, callback receiver and connect/disconnect remain native', async () => {
  const owner = createAuthMaintenance();
  const store = new session.MemoryStore();
  const receiver = {};
  const sessions: Record<string, session.SessionData> = {
    fixture: { cookie: new session.Cookie() },
  };
  store.all = function (callback) {
    return callback.call(receiver, null, sessions);
  };
  const observed = createAuthSessionStore(store, owner);
  expect(observed.all!.length).toBe(store.all.length);
  expect(observed.get.length).toBe(store.get.length);
  const events: string[] = [];
  observed.on('connect', () => events.push('connect'));
  observed.on('disconnect', () => events.push('disconnect'));
  store.emit('connect');
  store.emit('disconnect');
  expect(events).toEqual(['connect', 'disconnect']);
  const callback = jest.fn(function (this: unknown, error, value) {
    expect(this).toBe(receiver);
    expect(error).toBeNull();
    expect(value).toBe(sessions);
  });
  await owner.run(undefined, () => observed.all!(callback));
  await tick();
  expect(callback).toHaveBeenCalledTimes(1);
});

test('store arguments retain undefined values and the original callback position', async () => {
  const owner = createAuthMaintenance();
  const store = new session.MemoryStore();
  const receiver = {};
  const callback = jest.fn(function (this: unknown, error) {
    expect(this).toBe(receiver);
    expect(error).toBeNull();
  });
  store.set = jest.fn(function (this: session.Store, sid, data, done) {
    expect(this).toBe(store);
    expect(sid).toBe('fixture');
    expect(data).toBeUndefined();
    expect(done!.length).toBe(callback.length);
    done!.call(receiver, null);
  });
  store.get = jest.fn(function (this: session.Store, sid, done) {
    expect(this).toBe(store);
    expect(sid).toBeUndefined();
    expect(typeof done).toBe('function');
    done(null);
  });
  const observed = createAuthSessionStore(store, owner);
  await owner.run(undefined, () => {
    observed.set('fixture', undefined as never, callback);
    observed.get(undefined as never, undefined as never);
  });
  await tick();
  expect(callback).toHaveBeenCalledTimes(1);
  expect(store.get).toHaveBeenCalledTimes(1);
  owner.pauseAdmissions('arguments');
  expect(await owner.getMaintenanceCensus('arguments')).toMatchObject({
    queuedContinuations: 0,
    pendingWrites: 0,
    complete: true,
  });
});
