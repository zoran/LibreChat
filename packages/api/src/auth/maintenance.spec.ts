import { Keyv } from 'keyv';
import http from 'node:http';
import express from 'express';
import { EventEmitter } from 'node:events';
import { createAuthMaintenance, observeAuthCacheWrite } from './maintenance';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function admit(owner: ReturnType<typeof createAuthMaintenance>) {
  const req = {} as never;
  const res = Object.assign(new EventEmitter(), {
    end: jest.fn(),
    setHeader: jest.fn(),
    status: jest.fn(),
    json: jest.fn(),
  });
  res.status.mockReturnValue(res);
  owner.admissionMiddleware(req, res as never, jest.fn());
  return { req, res };
}

test('accepted children survive pause and final response end until actual settlement', async () => {
  const owner = createAuthMaintenance();
  const { req, res } = admit(owner);
  const pending = deferred();
  const work = owner.run(req, async (operation) => {
    await pending.promise;
    await operation.write(async () => undefined);
  });
  owner.pauseAdmissions('drain');
  res.end();
  expect((await owner.getMaintenanceCensus('drain')).queuedContinuations).toBe(1);
  const rejected = admit(owner);
  expect(rejected.res.status).toHaveBeenCalledWith(503);
  pending.resolve();
  await work;
  expect(await owner.getMaintenanceCensus('drain')).toEqual({
    admissionClosed: true,
    queuedContinuations: 0,
    pendingWrites: 0,
    complete: true,
  });
});

test('a sanitized failed write cannot release its still-pending sibling or erase uncertainty', async () => {
  const owner = createAuthMaintenance();
  const { req, res } = admit(owner);
  const first = deferred();
  const second = deferred();
  let child!: Promise<void>;
  const work = owner.run(req, async (operation) => {
    child = operation.write(() => second.promise);
    await Promise.all([operation.write(() => first.promise), child]).catch(() => undefined);
  });
  owner.pauseAdmissions('drain');
  first.reject(new Error('uncertain'));
  await work;
  res.end();
  expect(await owner.getMaintenanceCensus('drain')).toMatchObject({
    queuedContinuations: 1,
    pendingWrites: 1,
    complete: false,
  });
  expect(owner.resumeAdmissions('drain')).toBe(false);
  second.resolve();
  await child;
  expect(await owner.getMaintenanceCensus('drain')).toMatchObject({
    queuedContinuations: 0,
    pendingWrites: 0,
    complete: false,
  });
});

test('failed credentials/read without a write remain a settled failed operation', async () => {
  const owner = createAuthMaintenance();
  await expect(
    owner.run(undefined, async () => {
      throw new Error('read failed');
    }),
  ).rejects.toThrow('read failed');
  owner.pauseAdmissions('drain');
  expect(await owner.getMaintenanceCensus('drain')).toMatchObject({
    complete: true,
    queuedContinuations: 0,
  });
  expect(owner.resumeAdmissions('other')).toBe(false);
  expect(owner.resumeAdmissions('drain')).toBe(true);
});

test('callback invocation and duplicate callbacks settle once at actual completion', async () => {
  const owner = createAuthMaintenance();
  let done!: (error?: unknown) => void;
  const work = owner.run(undefined, (operation) =>
    operation.callback((callback) => {
      done = callback;
    }),
  );
  owner.pauseAdmissions('drain');
  expect((await owner.getMaintenanceCensus('drain')).pendingWrites).toBe(1);
  done();
  done(new Error('duplicate'));
  await work;
  expect(await owner.getMaintenanceCensus('drain')).toMatchObject({
    complete: true,
    pendingWrites: 0,
  });
});

test('census cannot survive a pause revision change and invalid IDs cannot pause', async () => {
  const owner = createAuthMaintenance();
  expect(owner.pauseAdmissions(undefined as never)).toBe(false);
  const census = owner.getMaintenanceCensus(null);
  owner.pauseAdmissions('drain');
  expect((await census).complete).toBe(false);
});

test('a request without a terminal response signal remains live', async () => {
  const owner = createAuthMaintenance();
  const { req } = admit(owner);
  await owner.run(req, async () => undefined);
  owner.pauseAdmissions('drain');
  expect((await owner.getMaintenanceCensus('drain')).queuedContinuations).toBe(1);
});

test.each([false, true])(
  'actual HTTP peer close retains its write and callback; failed write=%s',
  async (fails) => {
    const owner = createAuthMaintenance();
    const write = deferred();
    const started = deferred();
    const closed = deferred();
    const settled = deferred();
    let callback!: () => void;
    const app = express();
    app.use(owner.admissionMiddleware);
    app.get(
      '/accepted',
      owner.own(async (_req, res) => {
        res.once('close', closed.resolve);
        const operation = owner.current()!;
        const pending = operation.write(() => write.promise).catch(() => undefined);
        const saving = operation.callback<void>((done) => {
          callback = done;
        });
        started.resolve();
        await Promise.all([pending, saving]);
        if (!res.destroyed) res.end();
        settled.resolve();
      }),
    );
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const request = http.get({ hostname: '127.0.0.1', port: address.port, path: '/accepted' });
    request.on('error', () => undefined);
    try {
      await started.promise;
      owner.pauseAdmissions('drain');
      request.destroy();
      await closed.promise;
      expect(await owner.getMaintenanceCensus('drain')).toMatchObject({
        queuedContinuations: 1,
        pendingWrites: 2,
        complete: true,
      });
      if (fails) write.reject(new Error('uncertain write'));
      else write.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      expect(await owner.getMaintenanceCensus('drain')).toMatchObject({
        queuedContinuations: 1,
        pendingWrites: 1,
        complete: !fails,
      });
      callback();
      await settled.promise;
      await new Promise((resolve) => setImmediate(resolve));
      expect(await owner.getMaintenanceCensus('drain')).toEqual({
        admissionClosed: true,
        queuedContinuations: 0,
        pendingWrites: 0,
        complete: !fails,
      });
      expect(owner.resumeAdmissions('drain')).toBe(!fails);
    } finally {
      write.resolve();
      callback?.();
      request.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test.each([true, false])(
  'cache SET preserves the actual result %s and records a refused write',
  async (result) => {
    const owner = createAuthMaintenance();
    expect(await observeAuthCacheWrite(owner, {}, 'set', async () => result)).toBe(result);
    owner.pauseAdmissions('drain');
    expect(await owner.getMaintenanceCensus('drain')).toMatchObject({
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: result,
    });
  },
);

test.each([false, true])(
  'actual Keyv DELETE preserves false while distinguishing storage failure=%s',
  async (fails) => {
    const owner = createAuthMaintenance();
    const store = new Map();
    const cache = new Keyv({ store });
    if (fails)
      jest.spyOn(store, 'delete').mockImplementation(() => {
        throw new Error('delete failed');
      });
    const listenerCount = cache.listeners('error').length;
    expect(await observeAuthCacheWrite(owner, cache, 'delete', () => cache.delete('absent'))).toBe(
      false,
    );
    expect(cache.listeners('error')).toHaveLength(listenerCount);
    owner.pauseAdmissions('drain');
    expect(await owner.getMaintenanceCensus('drain')).toMatchObject({
      pendingWrites: 0,
      queuedContinuations: 0,
      complete: !fails,
    });
  },
);

test('concurrent cache writes share one temporary error listener until the last write settles', async () => {
  const owner = createAuthMaintenance();
  const cache = new Keyv({ store: new Map() });
  const gate = deferred();
  const baseline = cache.listeners('error').length;
  const writes = Array.from({ length: 20 }, () =>
    observeAuthCacheWrite(owner, cache, 'set', () => gate.promise),
  );
  expect(cache.listeners('error')).toHaveLength(baseline + 1);
  gate.resolve();
  await Promise.all(writes);
  expect(cache.listeners('error')).toHaveLength(baseline);
});

test('a captured data continuation can retain the caller after response and report uncertainty', async () => {
  const owner = createAuthMaintenance();
  const { req, res } = admit(owner);
  const later = deferred();
  let child!: Promise<void>;
  await owner.run(req, (operation) => {
    child = operation.track(async () => {
      await later.promise;
      operation.markUncertain();
    });
  });
  res.end();
  owner.pauseAdmissions('drain');
  expect((await owner.getMaintenanceCensus('drain')).queuedContinuations).toBe(1);
  later.resolve();
  await child;
  expect(await owner.getMaintenanceCensus('drain')).toMatchObject({
    queuedContinuations: 0,
    pendingWrites: 0,
    complete: false,
  });
});
