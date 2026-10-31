/** Real ACL/probe/afterwork owners retain originals; storage handles are inert and controlled. */
import { Types } from 'mongoose';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';
import { MongoClient, MongoServerError } from 'mongodb';
import {
  ResourceType,
  PrincipalType,
  PermissionBits,
  AccessRoleIds,
} from 'librechat-data-provider';
import type { AllMethods, AuthContinuationObserver } from '@librechat/data-schemas';
import type { ClientSession } from 'mongoose';
import { AccessControlService } from './accessControlService';

const { createPermissionMaintenance } = jest.requireActual(
  '../../../../api/server/services/PermissionMaintenance',
);
jest.mock('~/cache', () => ({ userPrincipalsCache: jest.fn() }));
jest.mock('~/config/winston', () => ({ debug: jest.fn(), error: jest.fn(), warn: jest.fn() }));
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn() },
  createMethods: jest.fn(() => {
    throw new Error('Fixture must pass its actual methods');
  }),
}));
function rejectsWith(original: Promise<unknown>, message: string) {
  const assertion = (async () => {
    await expect(original).rejects.toThrow(message);
  })();
  void assertion.catch(() => undefined); // Observe immediately; the owning test still awaits it.
  return assertion;
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type ControlledLifecycle = {
  startTransaction(): void;
  commitTransaction(): Promise<void>;
  abortTransaction(): Promise<void>;
  inTransaction(): boolean;
};
function sessionFor(client: object) {
  let active = false;
  return Object.assign(new EventEmitter(), {
    client,
    hasEnded: false,
    timeoutMS: undefined as number | undefined,
    withTransaction: jest.fn(async function (
      this: ControlledLifecycle,
      callback: () => Promise<unknown>,
      _options?: { timeoutMS?: number },
    ) {
      this.startTransaction();
      try {
        const result = await callback();
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
    endSession: jest.fn(async function (this: EventEmitter & { hasEnded: boolean }) {
      this.hasEnded = true;
      active = false;
      this.emit('ended');
    }),
  });
}
function fixture(client: object = {}) {
  const probe = sessionFor(client);
  const mutation = sessionFor(client);
  const originals = {
    startTransaction: mutation.startTransaction,
    commitTransaction: mutation.commitTransaction,
  };
  const read = jest.fn(async () => null);
  const db = { collection: jest.fn(() => ({ findOne: read })) };
  const connection = {
    client,
    db,
    getClient: () => connection.client,
    startSession: jest.fn().mockResolvedValueOnce(probe).mockResolvedValue(mutation),
  };
  const mongoose = { connection, startSession: () => connection.startSession() };
  const role = {
    _id: new Types.ObjectId(),
    accessRoleId: AccessRoleIds.AGENT_VIEWER,
    resourceType: ResourceType.AGENT,
    permBits: PermissionBits.VIEW,
  };
  const methods = {
    findRolesByResourceType: jest.fn(async () => [role]),
    findEntriesByResource: jest.fn(async () => []),
    replaceRoleBits: jest.fn(async () => ({})),
    bulkWriteAclEntries: jest.fn(async () => ({ upsertedIds: {} })),
    deleteAclEntries: jest.fn(async () => ({ deletedCount: 1 })),
    invalidatePromptGroupAccessContext: jest.fn(async (_observer?: AuthContinuationObserver) => {}),
  };
  const service = new AccessControlService(
    mongoose as unknown as typeof import('mongoose'),
    methods as unknown as AllMethods,
  );
  const args = {
    resourceType: ResourceType.AGENT,
    resourceId: new Types.ObjectId(),
    grantedBy: new Types.ObjectId(),
  };
  const principal = {
    type: PrincipalType.USER,
    id: new Types.ObjectId().toString(),
    accessRoleId: AccessRoleIds.AGENT_VIEWER,
  };
  return { probe, mutation, originals, read, connection, methods, service, args, principal };
}
async function census(owner: ReturnType<typeof createPermissionMaintenance>) {
  expect(owner.pauseAdmissions('hold')).toBe(true);
  return owner.getMaintenanceCensus('hold');
}

describe('AccessControlService raw-session maintenance child', () => {
  it('refuses acquisition drift after a successful probe and cleans only the newly acquired handle', async () => {
    const f = fixture();
    const acquired = deferred<ReturnType<typeof sessionFor>>();
    f.connection.startSession
      .mockReset()
      .mockResolvedValueOnce(f.probe)
      .mockReturnValueOnce(acquired.promise);
    const owner = createPermissionMaintenance();
    const original = owner.run((observer: AuthContinuationObserver) =>
      f.service.bulkUpdateResourcePermissions({ ...f.args, observer }),
    );
    const outcome = rejectsWith(original, 'ACL original connection or session identity changed');
    try {
      await flush();
      expect(f.probe.commitTransaction).toHaveBeenCalledTimes(1);
      expect(f.probe.endSession).toHaveBeenCalledTimes(1);
      expect(f.connection.startSession).toHaveBeenCalledTimes(2);
      expect((await census(owner)).queuedContinuations).toBe(1);
      f.connection.client = {};
      f.connection.db = { collection: jest.fn() };
      const replacement = sessionFor(f.connection.client);
      acquired.resolve(replacement);
      await outcome;
      expect(replacement.startTransaction).not.toHaveBeenCalled();
      expect(replacement.abortTransaction).not.toHaveBeenCalled();
      expect(replacement.endSession).toHaveBeenCalledTimes(1);
      expect(f.mutation.endSession).not.toHaveBeenCalled();
      expect(f.methods.findRolesByResourceType).not.toHaveBeenCalled();
      expect(f.methods.bulkWriteAclEntries).not.toHaveBeenCalled();
      expect((await census(owner)).complete).toBe(false);
    } finally {
      acquired.resolve(f.mutation);
      await Promise.allSettled([original, outcome]);
    }
  });

  it('does not dispatch the second lookup when the actual first original rejects', async () => {
    const f = fixture();
    const failure = new Error('roles failed');
    f.methods.findRolesByResourceType.mockRejectedValue(failure);
    const owner = createPermissionMaintenance();
    const original = owner.run((observer: AuthContinuationObserver) =>
      f.service.bulkUpdateResourcePermissions({ ...f.args, observer }),
    );
    await expect(original).rejects.toBe(failure);
    expect(f.methods.findEntriesByResource).not.toHaveBeenCalled();
    expect(f.mutation.abortTransaction).toHaveBeenCalled();
    expect(f.mutation.endSession).toHaveBeenCalledTimes(1);
    expect((await census(owner)).complete).toBe(false);
  });

  it('retains cleanup after synchronous mutation start failure and preserves its first error', async () => {
    const f = fixture();
    const end = deferred();
    f.mutation.startTransaction.mockImplementation(() => {
      throw new Error('mutation start failed');
    });
    f.mutation.abortTransaction.mockRejectedValue(new Error('abort failed'));
    f.mutation.endSession.mockReturnValue(end.promise);
    const owner = createPermissionMaintenance();
    const original = owner.run((observer: AuthContinuationObserver) =>
      f.service.bulkUpdateResourcePermissions({ ...f.args, observer }),
    );
    const outcome = rejectsWith(original, 'mutation start failed');
    try {
      await flush();
      expect((await census(owner)).queuedContinuations).toBe(1);
      expect(f.mutation.endSession).toHaveBeenCalledTimes(1);
      end.reject(new Error('end failed'));
      await outcome;
      expect(f.methods.findRolesByResourceType).not.toHaveBeenCalled();
    } finally {
      end.reject(new Error('end failed'));
      await Promise.allSettled([original, outcome]);
    }
  });

  it('keeps a clean body uncertain when owned end fails', async () => {
    const f = fixture();
    const end = deferred();
    f.mutation.endSession.mockReturnValue(end.promise);
    const owner = createPermissionMaintenance();
    const original = owner.run((observer: AuthContinuationObserver) =>
      f.service.bulkUpdateResourcePermissions({ ...f.args, observer }),
    );
    const outcome = rejectsWith(original, 'only end failed');
    try {
      await flush();
      expect(f.originals.commitTransaction).toHaveBeenCalledTimes(1);
      expect(f.mutation.endSession).toHaveBeenCalledTimes(1);
      expect((await census(owner)).queuedContinuations).toBe(1);
      end.reject(new Error('only end failed'));
      await outcome;
      expect(f.mutation.abortTransaction).not.toHaveBeenCalled();
      expect((await census(owner)).complete).toBe(false);
    } finally {
      end.reject(new Error('only end failed'));
      await Promise.allSettled([original, outcome]);
    }
  });

  it.each(['role', 'bulk'] as const)(
    'retains the actual %s write and refuses clean settlement on rejection',
    async (kind) => {
      const f = fixture();
      const gate = deferred<never>();
      const target = kind === 'role' ? f.methods.replaceRoleBits : f.methods.bulkWriteAclEntries;
      target.mockReturnValue(gate.promise);
      const owner = createPermissionMaintenance();
      const principal = kind === 'role' ? f.principal : { ...f.principal, viewInsights: false };
      const original = owner.run((observer: AuthContinuationObserver) =>
        f.service.bulkUpdateResourcePermissions({
          ...f.args,
          updatedPrincipals: [principal],
          observer,
        }),
      );
      const outcome = rejectsWith(original, 'write failed');
      try {
        await flush();
        expect(target).toHaveBeenCalledTimes(1);
        const state = await census(owner);
        expect(state.queuedContinuations).toBe(1);
        expect(state.pendingWrites).toBeGreaterThan(0);
        expect(f.originals.commitTransaction).not.toHaveBeenCalled();
        gate.reject(new Error('write failed'));
        await outcome;
        expect((await census(owner)).complete).toBe(false);
      } finally {
        gate.reject(new Error('write failed'));
        await Promise.allSettled([original, outcome]);
      }
    },
  );

  it('preserves a fatal delete original without partial success or commit', async () => {
    const f = fixture();
    const gate = deferred<{ deletedCount: number }>();
    f.methods.deleteAclEntries.mockReturnValue(gate.promise);
    const owner = createPermissionMaintenance();
    const original = owner.run((observer: AuthContinuationObserver) =>
      f.service.bulkUpdateResourcePermissions({
        ...f.args,
        revokedPrincipals: [f.principal],
        observer,
      }),
    );
    const failure = new Error('delete failed');
    const outcome = rejectsWith(original, 'delete failed');
    try {
      await flush();
      expect((await census(owner)).pendingWrites).toBeGreaterThan(0);
      gate.reject(failure);
      await outcome;
      await expect(original).rejects.toBe(failure);
      expect(f.originals.commitTransaction).not.toHaveBeenCalled();
      expect((await census(owner)).complete).toBe(false);
    } finally {
      gate.reject(failure);
      await Promise.allSettled([original, outcome]);
    }
  });

  it('retains and reports the original compensating write before caller normalization', async () => {
    const f = fixture();
    const gate = deferred<never>();
    f.methods.bulkWriteAclEntries.mockReturnValue(gate.promise);
    const owner = createPermissionMaintenance();
    const original = owner.run((observer: AuthContinuationObserver) =>
      f.service.restoreInsightsPermissionChanges({
        ...f.args,
        changes: [
          { action: 'assigned', previousEntry: null, writtenEntry: null, principal: f.principal },
        ],
        observer,
      }),
    );
    const outcome = rejectsWith(original, 'compensation failed');
    try {
      await flush();
      expect((await census(owner)).pendingWrites).toBeGreaterThan(0);
      expect(f.connection.startSession).not.toHaveBeenCalled();
      gate.reject(new Error('compensation failed'));
      await outcome;
      expect((await census(owner)).complete).toBe(false);
    } finally {
      gate.reject(new Error('compensation failed'));
      await Promise.allSettled([original, outcome]);
    }
  });

  it.each(['commit', 'abort', 'end'] as const)(
    'never controls an external session and retains actual %s afterwork disposition',
    async (terminal) => {
      const f = fixture();
      const external = sessionFor(f.connection.client);
      const originals = {
        start: external.startTransaction,
        commit: external.commitTransaction,
        abort: external.abortTransaction,
        end: external.endSession,
      };
      external.startTransaction();
      const scope = new AsyncLocalStorage<string>();
      const gate = deferred();
      const observedTenants: Array<string | undefined> = [];
      f.methods.invalidatePromptGroupAccessContext.mockImplementation(async (observer) => {
        observedTenants.push(scope.getStore());
        await observer!.write(() => gate.promise);
      });
      const owner = createPermissionMaintenance();
      let ending: Promise<void> | undefined;
      try {
        await scope.run('tenant-a', () =>
          owner.run((observer: AuthContinuationObserver) =>
            f.service.bulkUpdateResourcePermissions({
              ...f.args,
              resourceType: ResourceType.PROMPTGROUP,
              session: external as unknown as ClientSession,
              observer,
            }),
          ),
        );
        expect(originals.start).toHaveBeenCalledTimes(1);
        expect(originals.commit).not.toHaveBeenCalled();
        expect(originals.abort).not.toHaveBeenCalled();
        expect(originals.end).not.toHaveBeenCalled();
        expect(f.connection.startSession).toHaveBeenCalledTimes(1);
        expect((await census(owner)).queuedContinuations).toBe(1);
        if (terminal === 'commit') {
          ending = external.commitTransaction();
          await flush();
          expect(observedTenants).toEqual(['tenant-a']);
          expect((await census(owner)).pendingWrites).toBeGreaterThan(0);
          gate.resolve();
          await ending;
        } else if (terminal === 'abort') await external.abortTransaction();
        else await external.endSession();
        await flush();
        expect((await census(owner)).queuedContinuations).toBe(0);
        expect((await census(owner)).complete).toBe(false);
        if (terminal !== 'commit')
          expect(f.methods.invalidatePromptGroupAccessContext).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
        await ending?.catch(() => undefined);
        await external.endSession();
      }
    },
  );

  it('refuses a caller-owned session from a different client without controlling it', async () => {
    const f = fixture();
    const external = sessionFor({});
    const owner = createPermissionMaintenance();
    await expect(
      owner.run((observer: AuthContinuationObserver) =>
        f.service.bulkUpdateResourcePermissions({
          ...f.args,
          session: external as unknown as ClientSession,
          observer,
        }),
      ),
    ).rejects.toThrow('identity changed');
    expect(f.methods.findRolesByResourceType).not.toHaveBeenCalled();
    for (const method of [
      external.startTransaction,
      external.commitTransaction,
      external.abortTransaction,
      external.endSession,
    ])
      expect(method).not.toHaveBeenCalled();
  });

  it('preserves validation results without inventing persistence uncertainty', async () => {
    const f = fixture();
    const owner = createPermissionMaintenance();
    const result = await owner.run((observer: AuthContinuationObserver) =>
      f.service.bulkUpdateResourcePermissions({
        ...f.args,
        updatedPrincipals: [{ ...f.principal, id: 'not-an-id' }],
        observer,
      }),
    );
    expect(result.errors).toHaveLength(1);
    expect(f.methods.replaceRoleBits).not.toHaveBeenCalled();
    expect((await census(owner)).complete).toBe(true);
  });
  it.each(['body-third', 'commit-third', 'unknown-commit', 'unknown-max-time'] as const)(
    'uses pinned native driver for %s without a fourth data start',
    async (mode) => {
      const client = new MongoClient('mongodb://127.0.0.1:27017');
      const native = client.startSession(); // No connection or native DB operation is needed by these controlled DAO ports.
      const f = fixture(client);
      f.connection.startSession
        .mockReset()
        .mockResolvedValueOnce(f.probe)
        .mockResolvedValue(native);
      const start = jest.spyOn(native, 'startTransaction');
      const nativeCommit = native.commitTransaction.bind(native);
      const commit = jest.spyOn(native, 'commitTransaction');
      const errorLabels = mode.startsWith('unknown')
        ? ['UnknownTransactionCommitResult']
        : ['TransientTransactionError'];
      if (mode === 'unknown-max-time') errorLabels.push('TransientTransactionError');
      const original = new MongoServerError({
        message: 'native labelled failure',
        ...(mode === 'unknown-max-time' && { code: 50 }),
        errorLabels,
      });
      const labels = [...original.errorLabels];
      const owner = createPermissionMaintenance();
      try {
        if (mode === 'body-third') f.methods.findRolesByResourceType.mockRejectedValue(original);
        else if (mode === 'commit-third')
          commit.mockImplementation(async () => {
            await nativeCommit(); // Advance the real empty-session state without issuing a network command.
            throw original;
          });
        else commit.mockRejectedValueOnce(original);
        const operation = owner.run((observer: AuthContinuationObserver) =>
          f.service.bulkUpdateResourcePermissions({ ...f.args, observer }),
        );
        if (mode !== 'unknown-commit') {
          await expect(operation).rejects.toMatchObject({ cause: original });
          expect(start).toHaveBeenCalledTimes(mode === 'unknown-max-time' ? 1 : 3);
          expect(f.methods.findRolesByResourceType).toHaveBeenCalledTimes(
            mode === 'unknown-max-time' ? 1 : 3,
          );
          expect(commit).toHaveBeenCalledTimes(
            { 'body-third': 0, 'commit-third': 3, 'unknown-max-time': 1 }[mode],
          );
          expect((await census(owner)).complete).toBe(false);
        } else {
          await operation;
          expect(start).toHaveBeenCalledTimes(1);
          expect(f.methods.findRolesByResourceType).toHaveBeenCalledTimes(1);
          expect(commit).toHaveBeenCalledTimes(2);
        }
        expect(original.errorLabels).toEqual(labels);
        expect(native.hasEnded).toBe(true);
      } finally {
        await native.endSession();
        await client.close();
      }
    },
  );

  it('retains commit/cache/end originals after a late dispatch fence without TypeError or body replay', async () => {
    const f = fixture();
    const commit = deferred();
    const cache = deferred();
    const end = deferred();
    const commitImplementation = f.originals.commitTransaction.getMockImplementation();
    if (!commitImplementation) throw new Error('Missing original commit implementation');
    f.mutation.commitTransaction.mockImplementation(async function (this: ControlledLifecycle) {
      await commit.promise;
      await commitImplementation.call(this);
    });
    f.methods.invalidatePromptGroupAccessContext.mockReturnValue(cache.promise);
    f.mutation.endSession.mockReturnValue(end.promise);
    let clock = 0;
    const now = jest.spyOn(performance, 'now').mockImplementation(() => clock);
    const owner = createPermissionMaintenance();
    const operation = owner.run((observer: AuthContinuationObserver) =>
      f.service.bulkUpdateResourcePermissions({
        ...f.args,
        resourceType: ResourceType.PROMPTGROUP,
        observer,
      }),
    );
    const outcome = rejectsWith(operation, 'dispatch budget exhausted');
    try {
      await flush();
      expect(f.originals.commitTransaction).toHaveBeenCalledTimes(1);
      clock = 120001;
      commit.resolve();
      await flush();
      expect(f.methods.invalidatePromptGroupAccessContext).toHaveBeenCalledTimes(1);
      expect((await census(owner)).pendingWrites).toBeGreaterThan(0);
      expect(f.mutation.endSession).not.toHaveBeenCalled();
      cache.resolve();
      await flush();
      expect(f.mutation.endSession).toHaveBeenCalledTimes(1);
      expect((await census(owner)).pendingWrites).toBeGreaterThan(0);
      end.resolve();
      await outcome;
      expect(f.originals.startTransaction).toHaveBeenCalledTimes(1);
      expect(f.mutation.abortTransaction).not.toHaveBeenCalled();
    } finally {
      clock = 120001;
      commit.resolve();
      cache.resolve();
      end.resolve();
      await Promise.allSettled([operation, outcome]);
      now.mockRestore();
    }
  });

  it('preserves the shorter inherited native timeout and rejects late acquisition but joins its original end', async () => {
    const f = fixture();
    f.mutation.timeoutMS = 25;
    const owner = createPermissionMaintenance();
    await owner.run((observer: AuthContinuationObserver) =>
      f.service.bulkUpdateResourcePermissions({ ...f.args, observer }),
    );
    expect(f.mutation.withTransaction.mock.calls[0][1]).toEqual({ timeoutMS: 25 });
    const late = fixture();
    const acquired = deferred<ReturnType<typeof sessionFor>>();
    late.connection.startSession
      .mockReset()
      .mockResolvedValueOnce(late.probe)
      .mockReturnValueOnce(acquired.promise);
    let clock = 0;
    const now = jest.spyOn(performance, 'now').mockImplementation(() => clock);
    const operation = owner.run((observer: AuthContinuationObserver) =>
      late.service.bulkUpdateResourcePermissions({ ...late.args, observer }),
    );
    const outcome = rejectsWith(operation, 'dispatch budget exhausted');
    try {
      await flush();
      clock = 120001;
      acquired.resolve(late.mutation);
      await outcome;
      expect(late.mutation.startTransaction).not.toHaveBeenCalled();
      expect(late.mutation.endSession).toHaveBeenCalledTimes(1);
    } finally {
      clock = 120001;
      acquired.resolve(late.mutation);
      await Promise.allSettled([operation, outcome]);
      now.mockRestore();
    }
  });
  it.each(['last-dao', 'unknown-commit', 'ended-session'] as const)(
    'fences %s using the original owned handle without TypeError or retargeted commit',
    async (point) => {
      const client = new MongoClient('mongodb://127.0.0.1:27017');
      const native = client.startSession();
      const f = fixture(client);
      f.connection.startSession
        .mockReset()
        .mockResolvedValueOnce(f.probe)
        .mockResolvedValue(native);
      const start = jest.spyOn(native, 'startTransaction');
      const commit = jest.spyOn(native, 'commitTransaction');
      const owner = createPermissionMaintenance();
      const gate = deferred();
      if (point === 'unknown-commit') commit.mockImplementationOnce(() => gate.promise);
      else
        f.methods.findEntriesByResource.mockImplementationOnce(async () => {
          if (point === 'ended-session') await native.endSession();
          else f.connection.db = { collection: jest.fn() };
          return [];
        });
      const operation = owner.run((observer: AuthContinuationObserver) =>
        f.service.bulkUpdateResourcePermissions({ ...f.args, observer }),
      );
      const outcome = rejectsWith(operation, 'identity changed');
      try {
        if (point === 'unknown-commit') {
          await flush();
          f.connection.client = {};
          gate.reject(
            new MongoServerError({
              message: 'uncertain commit',
              errorLabels: ['UnknownTransactionCommitResult'],
            }),
          );
        }
        await outcome;
        expect(start).toHaveBeenCalledTimes(1);
        expect(commit).toHaveBeenCalledTimes(point === 'unknown-commit' ? 1 : 0);
        expect(native.hasEnded).toBe(true);
        expect((await census(owner)).complete).toBe(false);
      } finally {
        gate.resolve();
        await Promise.allSettled([operation, outcome]);
        await native.endSession();
        await client.close();
      }
    },
  );
  it('keeps the exact fatal DAO original when native callback abort and original end also fail', async () => {
    const client = new MongoClient('mongodb://127.0.0.1:27017');
    const native = client.startSession();
    const f = fixture(client);
    f.connection.startSession.mockReset().mockResolvedValueOnce(f.probe).mockResolvedValue(native);
    const daoError = new Error('fatal DAO original');
    const abortError = new Error('later native abort');
    const endError = new Error('later original end');
    const aborted = deferred();
    const ended = deferred();
    const start = jest.spyOn(native, 'startTransaction');
    const commit = jest.spyOn(native, 'commitTransaction');
    const realEnd = native.endSession.bind(native);
    const realAbort = native.abortTransaction.bind(native);
    const abort = jest.spyOn(native, 'abortTransaction').mockImplementation(async () => {
      await aborted.promise;
      throw abortError;
    });
    const end = jest.spyOn(native, 'endSession').mockImplementation(async () => {
      await ended.promise;
      throw endError;
    });
    f.methods.deleteAclEntries.mockRejectedValue(daoError);
    const owner = createPermissionMaintenance();
    const operation = owner.run((observer: AuthContinuationObserver) =>
      f.service.bulkUpdateResourcePermissions({
        ...f.args,
        revokedPrincipals: [f.principal],
        observer,
      }),
    );
    const outcome = rejectsWith(operation, 'fatal DAO original');
    try {
      await flush();
      expect(abort).toHaveBeenCalledTimes(1);
      expect((await census(owner)).pendingWrites).toBeGreaterThan(0);
      aborted.resolve();
      await flush();
      expect(end).toHaveBeenCalledTimes(1);
      expect((await census(owner)).pendingWrites).toBeGreaterThan(0);
      ended.resolve();
      await outcome;
      await expect(operation).rejects.toBe(daoError);
      expect(start).toHaveBeenCalledTimes(1);
      expect(commit).not.toHaveBeenCalled();
      expect(f.methods.deleteAclEntries).toHaveBeenCalledTimes(1);
      expect((await census(owner)).complete).toBe(false);
      const log = jest.requireMock('@librechat/data-schemas').logger.error;
      expect(log).toHaveBeenCalledWith(expect.any(String), abortError);
      expect(log).toHaveBeenCalledWith(expect.any(String), endError);
    } finally {
      aborted.resolve();
      ended.resolve();
      await Promise.allSettled([operation, outcome]);
      abort.mockRestore();
      end.mockRestore();
      await realAbort().catch(() => undefined);
      await realEnd();
      await client.close();
    }
  });
});
