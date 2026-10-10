import { Socket } from 'node:net';
import session from 'express-session';
import { EventEmitter } from 'node:events';
import { IncomingMessage, ServerResponse } from 'node:http';
import { createAuthSessionStore } from './sessionMaintenance';
import { createAuthMaintenance } from './maintenance';

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
