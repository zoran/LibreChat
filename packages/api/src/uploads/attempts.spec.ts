import type { UploadAttemptBinding } from './contract';
import { createUploadAttemptJournal } from './attempts';

const worker = { hostId: 'host', instanceId: 'current' };
const binding: UploadAttemptBinding = { ...worker, operationId: 'operation', generation: 1 };
const task = { operationId: binding.operationId, generation: binding.generation, worker };
const stopped = {
  writerStopped: true,
  localCopiesAbsent: true,
  storageOutcome: 'durable' as const,
};
const unknown = { writerStopped: false, localCopiesAbsent: false };
const signal = () => new AbortController().signal;

describe('shared upload attempt journal', () => {
  it('binds a real App writer without inventing an intake lease', async () => {
    const journal = createUploadAttemptJournal(worker);
    const registration = journal.attempts.begin(jest.fn());
    expect(await journal.maintenance.getMaintenanceCensus(null)).toMatchObject({
      queuedContinuations: 1,
      pendingWrites: 0,
    });
    registration.bind(binding);
    expect(await journal.maintenance.getMaintenanceCensus(null)).toMatchObject({
      queuedContinuations: 0,
      pendingWrites: 1,
    });
    registration.settle(stopped);
    expect(await journal.attempts.stopAndJoin(task, signal())).toEqual(stopped);
    await expect(journal.close()).resolves.toEqual({ complete: true });
  });

  test.each([{ ...worker, hostId: 'foreign' }, { ...worker, instanceId: 'previous' }, undefined])(
    'rejects a missing or foreign worker lookup: %j',
    async (foreign) => {
      const journal = createUploadAttemptJournal(worker);
      const abort = jest.fn();
      const registration = journal.attempts.begin(abort);
      registration.bind(binding);
      expect(await journal.attempts.stopAndJoin({ ...task, worker: foreign }, signal())).toEqual(
        unknown,
      );
      journal.attempts.recordCleanup({ ...task, worker: foreign }, stopped);
      expect(abort).not.toHaveBeenCalled();
      expect((await journal.maintenance.getMaintenanceCensus(null)).pendingWrites).toBe(1);
      registration.settle(stopped);
      await journal.close();
    },
  );

  test.each([
    { ...binding, hostId: 'other' },
    { ...binding, instanceId: 'old' },
    { ...binding, generation: 0 },
    { ...binding, operationId: '../invalid' },
  ])('does not admit invalid bindings: %j', async (invalid) => {
    const journal = createUploadAttemptJournal(worker);
    const registration = journal.attempts.begin(jest.fn());
    expect(() => registration.bind(invalid)).toThrow();
    registration.settle(stopped);
    await expect(journal.close()).resolves.toEqual({ complete: true });
  });

  it('snapshots both the actual worker and the minimal binding', async () => {
    const identity = { ...worker };
    const mutable = { ...binding };
    const journal = createUploadAttemptJournal(identity);
    const registration = journal.attempts.begin(jest.fn());
    identity.instanceId = 'mutated';
    registration.bind(mutable);
    mutable.operationId = 'other';
    mutable.generation = 2;
    registration.settle(stopped);
    expect(await journal.attempts.stopAndJoin(task, signal())).toEqual(stopped);
    await journal.close();
  });

  it('does not steal an active attempt or let a settled registration bind later', async () => {
    const journal = createUploadAttemptJournal(worker);
    const first = journal.attempts.begin(jest.fn());
    const second = journal.attempts.begin(jest.fn());
    first.bind(binding);
    expect(() => first.bind(binding)).toThrow('lease_lost');
    expect(() => second.bind(binding)).toThrow('lease_lost');
    second.settle(stopped);
    expect(() => second.bind({ ...binding, generation: 2 })).toThrow('lease_lost');
    first.settle(stopped);
    first.settle(unknown);
    await expect(journal.close()).resolves.toEqual({ complete: true });
  });

  it('joins only when the actual writer settles, retaining timeout evidence', async () => {
    const journal = createUploadAttemptJournal(worker);
    const abort = jest.fn();
    const registration = journal.attempts.begin(abort);
    registration.bind(binding);
    const timeout = new AbortController();
    const joining = journal.attempts.stopAndJoin(task, timeout.signal);
    expect(abort).toHaveBeenCalledTimes(1);
    timeout.abort();
    await expect(joining).resolves.toEqual(unknown);
    journal.attempts.recordCleanup(task, stopped);
    expect((await journal.maintenance.getMaintenanceCensus(null)).pendingWrites).toBe(1);
    registration.settle(stopped);
    expect(await journal.attempts.stopAndJoin(task, signal())).toEqual(stopped);
    await journal.close();
  });

  it('closes admission synchronously and joins a claim binding after shutdown begins', async () => {
    const journal = createUploadAttemptJournal(worker);
    const abort = jest.fn();
    const registration = journal.attempts.begin(abort);
    let finished = false;
    const closing = journal.close().then((result) => {
      finished = true;
      return result;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(() => journal.attempts.begin(jest.fn())).toThrow('unavailable');
    registration.bind(binding);
    expect(abort).toHaveBeenCalledTimes(2);
    registration.settle(stopped);
    await expect(closing).resolves.toEqual({ complete: true });
    expect(journal.maintenance.pauseAdmissions('late')).toBe(false);
  });

  it('retains an active writer after close times out and can later join its actual settlement', async () => {
    const journal = createUploadAttemptJournal(worker);
    const registration = journal.attempts.begin(jest.fn());
    registration.bind(binding);
    const timeout = new AbortController();
    const closing = journal.close(timeout.signal);
    timeout.abort();
    await expect(closing).resolves.toEqual({ complete: false });
    expect((await journal.maintenance.getMaintenanceCensus(null)).pendingWrites).toBe(1);
    registration.settle(stopped);
    await expect(journal.close()).resolves.toEqual({ complete: true });
  });

  it('keeps scanner cleanup separate from local and storage completion', async () => {
    const journal = createUploadAttemptJournal(worker);
    const registration = journal.attempts.begin(jest.fn());
    registration.bind(binding);
    registration.settle({ ...stopped, securityPending: true });
    expect(journal.maintenance.pauseAdmissions('owner')).toBe(true);
    expect(journal.maintenance.pauseAdmissions('other')).toBe(false);
    expect(journal.maintenance.resumeAdmissions('other')).toBe(false);
    journal.attempts.recordCleanup(task, stopped);
    expect(journal.maintenance.resumeAdmissions('owner')).toBe(false);
    journal.attempts.recordCleanup(task, { ...stopped, securityPending: false });
    expect(journal.maintenance.resumeAdmissions('owner')).toBe(true);
    await expect(journal.close()).resolves.toEqual({ complete: true });
  });

  it('bounds active registrations without discarding any admitted writer', async () => {
    const journal = createUploadAttemptJournal(worker);
    const registrations = Array.from({ length: 128 }, () => journal.attempts.begin(jest.fn()));
    expect(() => journal.attempts.begin(jest.fn())).toThrow('queue_full');
    expect((await journal.maintenance.getMaintenanceCensus(null)).queuedContinuations).toBe(128);
    registrations.forEach((registration) => registration.settle(stopped));
    await expect(journal.close()).resolves.toEqual({ complete: true });
  });

  test.each([
    [stopped, true],
    [{ ...stopped, storageOutcome: 'unknown' as const }, false],
    [{ ...stopped, securityPending: true }, false],
  ])('retains uncertainty after bounded receipt eviction: %j', async (first, complete) => {
    const journal = createUploadAttemptJournal(worker);
    for (let generation = 1; generation <= 257; generation++) {
      const registration = journal.attempts.begin(jest.fn());
      registration.bind({ ...binding, generation });
      registration.settle(generation === 1 ? first : stopped);
    }
    expect(await journal.attempts.stopAndJoin(task, signal())).toEqual(unknown);
    journal.attempts.recordCleanup(task, stopped);
    expect((await journal.maintenance.getMaintenanceCensus(null)).complete).toBe(complete);
    await expect(journal.close()).resolves.toEqual({ complete });
  });

  test.each([
    { ...stopped, writerStopped: false },
    { ...stopped, localCopiesAbsent: false },
    { ...stopped, securityPending: true },
  ])('retains incomplete evidence even without a successful claim: %j', async (proof) => {
    const journal = createUploadAttemptJournal(worker);
    journal.attempts.begin(jest.fn()).settle(proof);
    expect((await journal.maintenance.getMaintenanceCensus(null)).complete).toBe(false);
    await expect(journal.close()).resolves.toEqual({ complete: false });
  });
});
