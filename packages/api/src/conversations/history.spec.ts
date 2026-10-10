import { createHistoryMutationOwner, isHistoryConversationResult } from './history';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe('history maintenance ownership', () => {
  it('refuses undeclared JavaScript operations and retains the coverage uncertainty', async () => {
    const owner = createHistoryMutationOwner();
    expect(owner.admit('future-route' as never)).toBeUndefined();
    expect((await owner.getMaintenanceCensus(null)).complete).toBe(false);
  });

  it('holds accepted children after root completion and closes new admission synchronously', async () => {
    const owner = createHistoryMutationOwner();
    const scope = owner.admit('message-feedback')!;
    const child = deferred<void>();
    const work = scope.write(() => child.promise);
    scope.finish();
    expect(owner.pauseAdmissions('a')).toBe(true);
    expect(owner.admit('message-save')).toBeUndefined();
    expect(await owner.getMaintenanceCensus('a')).toEqual({
      admissionClosed: true,
      queuedContinuations: 0,
      pendingWrites: 1,
      complete: true,
    });
    expect(owner.resumeAdmissions('b')).toBe(false);
    child.resolve();
    await work;
    expect((await owner.getMaintenanceCensus('a')).pendingWrites).toBe(0);
    expect(owner.resumeAdmissions('a')).toBe(true);
  });

  it.each(['reject', 'hidden-result'] as const)(
    'retains unknown %s after cancellation',
    async (mode) => {
      const owner = createHistoryMutationOwner();
      const scope = owner.admit('message-save')!;
      if (mode === 'reject') {
        await expect(
          scope.write(() => Promise.reject(new Error('lost acknowledgment'))),
        ).rejects.toThrow();
      } else {
        await scope.write(
          () => ({ message: 'Error saving conversation' }),
          isHistoryConversationResult,
        );
      }
      scope.finish();
      owner.pauseAdmissions('a');
      expect(await owner.getMaintenanceCensus('a')).toMatchObject({
        complete: false,
        pendingWrites: 0,
      });
      expect(owner.resumeAdmissions('a')).toBe(false);
    },
  );

  it('keeps late storage cleanup admitted while its parent callback releases', async () => {
    const owner = createHistoryMutationOwner();
    const scope = owner.admit('conversation-import')!;
    const finishWrite = scope.hold('write');
    scope.finish();
    owner.pauseAdmissions('a');
    const finishRemoval = scope.hold('write');
    finishWrite();
    expect((await owner.getMaintenanceCensus('a')).pendingWrites).toBe(1);
    finishRemoval();
    expect(await owner.getMaintenanceCensus('a')).toMatchObject({
      complete: true,
      pendingWrites: 0,
    });
  });

  it('fails closed for a callback resurrected after all accepted work settled', async () => {
    const owner = createHistoryMutationOwner();
    const scope = owner.admit('conversation-import')!;
    scope.finish();
    scope.hold('write')();
    expect((await owner.getMaintenanceCensus(null)).complete).toBe(false);
  });

  it('does not mistake stale request IDs or duplicate callback release for a known census', async () => {
    const owner = createHistoryMutationOwner();
    const scope = owner.admit('message-edit')!;
    const release = scope.hold('write');
    release();
    release();
    scope.finish();
    owner.pauseAdmissions('a');
    expect((await owner.getMaintenanceCensus('b')).complete).toBe(false);
    expect((await owner.getMaintenanceCensus('a')).pendingWrites).toBe(0);
  });
});
