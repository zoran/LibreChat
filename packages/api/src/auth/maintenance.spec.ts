import { createAuthMaintenance } from './maintenance';

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
  const res = { end: jest.fn(), setHeader: jest.fn(), status: jest.fn(), json: jest.fn() };
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

test('disconnect without a proven terminal callback never declares a request idle', async () => {
  const owner = createAuthMaintenance();
  const { req } = admit(owner);
  await owner.run(req, async () => undefined);
  owner.pauseAdmissions('drain');
  expect((await owner.getMaintenanceCensus('drain')).queuedContinuations).toBe(1);
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
