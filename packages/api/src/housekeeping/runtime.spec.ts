import { HOUSEKEEPING_HANDLERS } from 'librechat-data-provider';
import type {
  HousekeepingRepository,
  JobClaim,
  WorkerIdentity,
  StepOutcome,
} from '@librechat/data-schemas';
import { createHousekeepingRuntime } from './runtime';

const identity: WorkerIdentity = {
  podUid: '11111111-1111-4111-8111-111111111111',
  incarnation: '22222222-2222-4222-8222-222222222222',
  source: 'a'.repeat(40),
  hostId: 'cpu2',
};
const later = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
function fixture() {
  const repository: jest.Mocked<HousekeepingRepository> = {
    discover: jest.fn().mockResolvedValue({ cursor: null, scanned: 0, complete: true }),
    claimNext: jest.fn().mockResolvedValue(null),
    renew: jest.fn(),
    inspect: jest.fn().mockResolvedValue({ state: 'unknown' }),
    defer: jest.fn().mockResolvedValue('recorded'),
    releaseUnstarted: jest.fn().mockResolvedValue('recorded'),
    readStatus: jest.fn(),
  };
  const handlers = {
    'file.warning': jest.fn().mockResolvedValue({ state: 'settled', receiptRef: 'notice' }),
    'file.cleanup': jest.fn().mockResolvedValue({ state: 'settled', receiptRef: 'file' }),
    'upload.cleanup': jest.fn().mockResolvedValue({ state: 'settled', receiptRef: 'upload' }),
  };
  const close = jest.fn().mockResolvedValue(undefined);
  const runtime = createHousekeepingRuntime({ identity, repository, handlers, close });
  const claim = (handler = 'file.cleanup'): JobClaim => ({
    jobId: 'job',
    worker: identity,
    claimId: 'claim',
    fence: 7,
    progressRevision: 2,
    executionId: 'execution',
    leaseUntil: new Date(Date.now() + 90_000).toISOString(),
    work: (() => {
      if (handler === 'upload.cleanup')
        return {
          handler,
          subject: { tenantId: null, ownerUserId: 'user' },
          operationId: 'operation',
          cleanupGeneration: 5,
          attemptGeneration: 2,
        };
      if (handler === 'file.warning')
        return {
          handler,
          subject: { tenantId: null, ownerUserId: 'user', fileId: 'file' },
          deadlineGeneration: 3,
          offsetDays: 1,
        };
      return {
        handler: 'file.cleanup',
        subject: { tenantId: null, ownerUserId: 'user', fileId: 'file' },
        deadlineGeneration: 3,
        revocationId: 'revoked',
      };
    })(),
  });
  const offer = () => repository.claimNext.mockImplementation(async (handler) => claim(handler));
  return { runtime, repository, handlers, close, claim, offer };
}
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-21T00:00:00Z'));
});
afterEach(() => {
  jest.useRealTimers();
});

test('construction is inert; pause closes admission before a scheduled discovery or claim', async () => {
  const f = fixture();
  expect(jest.getTimerCount()).toBe(0);
  expect(f.runtime.observe().lifecycle).toBe('starting');
  f.runtime.start();
  expect(f.runtime.pauseAdmissions('maintenance')).toBe(true);
  await jest.advanceTimersByTimeAsync(2000);
  expect(f.repository.discover).not.toHaveBeenCalled();
  expect(f.repository.claimNext).not.toHaveBeenCalled();
  expect(f.runtime.observe()).toMatchObject({ admitting: false, activeWorkCount: 0 });
  expect(f.runtime.resumeAdmissions('wrong')).toBe(false);
  expect(f.runtime.resumeAdmissions('maintenance')).toBe(true);
  await jest.advanceTimersByTimeAsync(0);
  expect(f.repository.claimNext).toHaveBeenCalledTimes(3);
  expect((await f.runtime.drain()).state).toBe('closed');
});

test('rotates all three actual handlers, one discovery page per handler per cycle', async () => {
  const f = fixture();
  f.offer();
  f.runtime.start();
  await jest.advanceTimersByTimeAsync(2100);
  const order = f.repository.claimNext.mock.calls.map(([handler]) => handler);
  expect(order).toHaveLength(3);
  expect(new Set(order)).toEqual(new Set(HOUSEKEEPING_HANDLERS));
  expect(f.repository.discover).toHaveBeenCalledTimes(3);
  await f.runtime.drain();
});

test('a claim promise reserves the sole execution slot; pause releases only the late unstarted claim', async () => {
  const f = fixture();
  const claim = later<JobClaim | null>();
  f.repository.claimNext.mockReturnValueOnce(claim.promise);
  f.runtime.start();
  await jest.advanceTimersByTimeAsync(0);
  expect(f.runtime.observe().activeWorkCount).toBe(1);
  await jest.advanceTimersByTimeAsync(4000);
  expect(f.repository.claimNext).toHaveBeenCalledTimes(1);
  f.runtime.pauseAdmissions('stop');
  const first = f.repository.claimNext.mock.calls[0][0];
  claim.resolve(f.claim(first));
  await flush();
  expect(f.repository.releaseUnstarted).toHaveBeenCalledTimes(1);
  expect(Object.values(f.handlers).every((handler) => handler.mock.calls.length === 0)).toBe(true);
  await f.runtime.drain();
});

test('heartbeat uses stable ownership despite concurrent progress and never overlaps renewals', async () => {
  const f = fixture();
  const effect = later<StepOutcome>();
  const renew = later<JobClaim | null>();
  f.offer();
  for (const handler of Object.values(f.handlers)) handler.mockReturnValue(effect.promise);
  f.repository.renew.mockReturnValue(renew.promise);
  f.runtime.start();
  await jest.advanceTimersByTimeAsync(20_000);
  expect(f.repository.renew).toHaveBeenCalledTimes(1);
  const supplied = f.repository.renew.mock.calls[0][0];
  expect(supplied).toEqual({ jobId: 'job', worker: identity, claimId: 'claim', fence: 7 });
  expect(supplied).not.toHaveProperty('progressRevision');
  await jest.advanceTimersByTimeAsync(20_000);
  expect(f.repository.renew).toHaveBeenCalledTimes(1);
  renew.resolve({ ...f.claim(f.repository.claimNext.mock.calls[0][0]), progressRevision: 99 });
  effect.resolve({ state: 'settled', receiptRef: 'actual-owner' });
  await flush();
  await f.runtime.drain();
});

test('45-second cancellation retains original effect and heartbeat custody through failed drain', async () => {
  const f = fixture();
  const effect = later<StepOutcome>();
  f.offer();
  for (const handler of Object.values(f.handlers)) handler.mockReturnValue(effect.promise);
  f.repository.renew.mockImplementation(async () =>
    f.claim(f.repository.claimNext.mock.calls[0][0]),
  );
  f.runtime.start();
  await jest.advanceTimersByTimeAsync(45_000);
  const handler = f.handlers[f.repository.claimNext.mock.calls[0][0]];
  expect(handler.mock.calls[0][1].aborted).toBe(true);
  expect(f.runtime.observe().activeWorkCount).toBe(1);
  const drain = f.runtime.drain();
  await jest.advanceTimersByTimeAsync(105_000);
  expect(await drain).toMatchObject({ state: 'unresolved', activeWorkCount: 1 });
  expect(f.close).not.toHaveBeenCalled();
  expect(f.repository.claimNext).toHaveBeenCalledTimes(1);
  expect(await f.runtime.getMaintenanceCensus(null)).toMatchObject({
    complete: true,
    queuedContinuations: 1,
    pendingWrites: 1,
  });
  effect.resolve({ state: 'settled', receiptRef: 'late-owner' });
  await flush();
  expect(f.runtime.observe().activeWorkCount).toBe(0);
});

test('a rejected claim is uncertain: no effect, no retry, and no clean close', async () => {
  const f = fixture();
  f.repository.claimNext.mockRejectedValue(new Error('lost acknowledgement'));
  f.runtime.start();
  await jest.advanceTimersByTimeAsync(5000);
  expect(f.repository.claimNext).toHaveBeenCalledTimes(1);
  expect(f.runtime.observe()).toMatchObject({ admitting: false, lifecycle: 'unknown' });
  expect(Object.values(f.handlers).every((handler) => handler.mock.calls.length === 0)).toBe(true);
  expect((await f.runtime.drain()).state).toBe('unresolved');
  expect(f.close).not.toHaveBeenCalled();
});

test('known pending work defers once and cannot starve the next handler', async () => {
  const f = fixture();
  f.offer();
  for (const handler of Object.values(f.handlers))
    handler.mockResolvedValue({ state: 'pending', code: 'external_pending' });
  f.runtime.start();
  await jest.advanceTimersByTimeAsync(2100);
  expect(new Set(f.repository.claimNext.mock.calls.map(([handler]) => handler)).size).toBe(3);
  expect(f.repository.defer).toHaveBeenCalledTimes(3);
  await f.runtime.drain();
});

test('unknown outcome inspects the same execution once without replay or invented settlement', async () => {
  const f = fixture();
  f.offer();
  for (const handler of Object.values(f.handlers)) handler.mockResolvedValue({ state: 'unknown' });
  f.runtime.start();
  await jest.advanceTimersByTimeAsync(0);
  f.runtime.pauseAdmissions('stop');
  expect(f.repository.inspect).toHaveBeenCalledWith('job', 'execution');
  expect(f.repository.defer).not.toHaveBeenCalled();
  expect((await f.runtime.drain()).state).toBe('unresolved');
  expect(f.close).not.toHaveBeenCalled();
});

test('close gets only the 15-second reserve, and timeout retains the original close promise', async () => {
  const f = fixture();
  const close = later<void>();
  f.close.mockReturnValue(close.promise);
  f.runtime.start();
  const drain = f.runtime.drain();
  await flush();
  expect(f.close).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(15_000);
  expect(await drain).toMatchObject({ state: 'unresolved', pendingPromises: 1 });
  expect(f.close.mock.calls[0][0].aborted).toBe(true);
  close.resolve();
  await flush();
  expect((await f.runtime.getMaintenanceCensus(null)).pendingWrites).toBe(0);
});

test('too little remaining lease releases the unstarted claim without an effect', async () => {
  const f = fixture();
  f.repository.claimNext.mockImplementation(async (handler) => ({
    ...f.claim(handler),
    leaseUntil: new Date(Date.now() + 54_999).toISOString(),
  }));
  f.runtime.start();
  await jest.advanceTimersByTimeAsync(0);
  expect(f.repository.releaseUnstarted).toHaveBeenCalledTimes(1);
  expect(Object.values(f.handlers).every((handler) => handler.mock.calls.length === 0)).toBe(true);
  expect((await f.runtime.drain()).state).toBe('closed');
});

test('fresh heartbeat progress snapshots do not cancel the same live ownership', async () => {
  const f = fixture();
  const effect = later<StepOutcome>();
  f.offer();
  for (const handler of Object.values(f.handlers)) handler.mockReturnValue(effect.promise);
  f.repository.renew.mockImplementation(async () => ({
    ...f.claim(f.repository.claimNext.mock.calls[0][0]),
    progressRevision: 999,
  }));
  f.runtime.start();
  await jest.advanceTimersByTimeAsync(40_000);
  expect(f.repository.renew).toHaveBeenCalledTimes(2);
  expect(f.handlers[f.repository.claimNext.mock.calls[0][0]].mock.calls[0][1].aborted).toBe(false);
  effect.resolve({ state: 'settled', receiptRef: 'owner' });
  await flush();
  expect((await f.runtime.drain()).state).toBe('closed');
});

test.each(['lost', 'rejected'])(
  'heartbeat %s cancels effects, inspects exact execution and prevents clean drain',
  async (mode) => {
    const f = fixture();
    const effect = later<StepOutcome>();
    f.offer();
    for (const handler of Object.values(f.handlers)) handler.mockReturnValue(effect.promise);
    if (mode === 'lost') f.repository.renew.mockResolvedValue(null);
    else f.repository.renew.mockRejectedValue(new Error('lost reply'));
    f.runtime.start();
    await jest.advanceTimersByTimeAsync(20_000);
    expect(f.handlers[f.repository.claimNext.mock.calls[0][0]].mock.calls[0][1].aborted).toBe(true);
    expect(f.repository.inspect).toHaveBeenCalledWith('job', 'execution');
    effect.resolve({ state: 'settled', receiptRef: 'late' });
    await flush();
    expect((await f.runtime.drain()).state).toBe('unresolved');
    expect(f.close).not.toHaveBeenCalled();
  },
);

test('confirmed durable external waiting work survives clean local drain without domain completion', async () => {
  const f = fixture();
  f.offer();
  for (const handler of Object.values(f.handlers))
    handler.mockResolvedValue({ state: 'pending', code: 'external_pending' });
  f.runtime.start();
  await jest.advanceTimersByTimeAsync(0);
  expect(f.repository.defer).toHaveBeenCalledTimes(1);
  expect(f.runtime.observe().activeWorkCount).toBe(0);
  expect((await f.runtime.drain()).state).toBe('closed');
  expect(f.close).toHaveBeenCalledTimes(1);
});

test('late heartbeat retains the slot even after handler settlement', async () => {
  const f = fixture();
  const effect = later<StepOutcome>();
  const renew = later<JobClaim | null>();
  f.offer();
  for (const handler of Object.values(f.handlers)) handler.mockReturnValue(effect.promise);
  f.repository.renew.mockReturnValue(renew.promise);
  f.runtime.start();
  await jest.advanceTimersByTimeAsync(20_000);
  effect.resolve({ state: 'settled', receiptRef: 'owner' });
  await flush();
  const drain = f.runtime.drain();
  await flush();
  expect(f.close).not.toHaveBeenCalled();
  expect(f.runtime.observe().activeWorkCount).toBe(1);
  renew.resolve(f.claim(f.repository.claimNext.mock.calls[0][0]));
  await flush();
  expect((await drain).state).toBe('closed');
  expect(f.close).toHaveBeenCalledTimes(1);
});

test('repeated drain joins the original deadline instead of creating a new envelope', async () => {
  const f = fixture();
  const claim = later<JobClaim | null>();
  f.repository.claimNext.mockReturnValue(claim.promise);
  f.runtime.start();
  await jest.advanceTimersByTimeAsync(0);
  const drain = f.runtime.drain();
  await jest.advanceTimersByTimeAsync(100_000);
  expect(f.runtime.drain()).toBe(drain);
  await jest.advanceTimersByTimeAsync(5000);
  expect((await drain).state).toBe('unresolved');
  claim.resolve(null);
  await flush();
  expect(f.close).not.toHaveBeenCalled();
});

test.each(['waiting', 'unknown', 'settled'] as const)(
  'exact owner-confirmed %s handoff survives local drain without replay',
  async (jobState) => {
    const f = fixture();
    f.offer();
    for (const handler of Object.values(f.handlers))
      handler.mockResolvedValue({ state: 'unknown' });
    f.repository.inspect.mockResolvedValue({
      state: 'observed',
      jobId: 'job',
      executionId: 'execution',
      jobState,
      phase: jobState === 'settled' ? 'complete' : 'unknown',
      progressRevision: 5,
      receiptRef: 'owner-reference',
      code: jobState === 'settled' ? 'settled' : 'submission_unknown',
    });
    f.runtime.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(f.repository.inspect).toHaveBeenCalledWith('job', 'execution');
    expect(f.repository.defer).not.toHaveBeenCalled();
    expect(f.repository.claimNext).toHaveBeenCalledTimes(1);
    expect((await f.runtime.drain()).state).toBe('closed');
  },
);

test('another execution observation or later successful job cannot clear unconfirmed local handoff', async () => {
  const f = fixture();
  f.offer();
  for (const handler of Object.values(f.handlers))
    handler
      .mockResolvedValueOnce({ state: 'unknown' })
      .mockResolvedValue({ state: 'settled', receiptRef: 'unrelated' });
  f.repository.inspect.mockResolvedValue({
    state: 'observed',
    jobId: 'different-job',
    executionId: 'different-execution',
    jobState: 'settled',
    phase: 'complete',
    progressRevision: 5,
    receiptRef: 'other-owner',
    code: 'settled',
  });
  f.runtime.start();
  await jest.advanceTimersByTimeAsync(3100);
  expect(f.repository.claimNext).toHaveBeenCalledTimes(4);
  expect((await f.runtime.drain()).state).toBe('unresolved');
  expect(f.close).not.toHaveBeenCalled();
});
