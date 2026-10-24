/** Real ACL/probe/afterwork owners retain originals; storage handles are inert and controlled. */
import { Types } from 'mongoose';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
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
  ...jest.requireActual('../../../data-schemas/src/utils/transactions'),
  runAfterTransaction: jest.requireActual('../../../data-schemas/src/methods/userGroup')
    .runAfterTransaction,
  logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn() },
  createMethods: jest.fn(() => {
    throw new Error('Fixture must pass its actual methods');
  }),
}));
function rejectsWith(original: Promise<unknown>, message: string) {
  return expect(original).rejects.toThrow(message);
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
function sessionFor(client: object) {
  let active = false;
  return Object.assign(new EventEmitter(), {
    client,
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
    endSession: jest.fn(async function (this: EventEmitter) {
      active = false;
      this.emit('ended');
    }),
  });
}
function fixture() {
  const client = {};
  const probe = sessionFor(client);
  const mutation = sessionFor(client);
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
  return { probe, mutation, read, connection, methods, service, args, principal };
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
  });

  it('joins a pending lookup sibling before abort/end after another lookup rejects', async () => {
    const f = fixture();
    const entries = deferred<never[]>();
    f.methods.findRolesByResourceType.mockRejectedValue(new Error('roles failed'));
    f.methods.findEntriesByResource.mockReturnValue(entries.promise);
    const owner = createPermissionMaintenance();
    const original = owner.run((observer: AuthContinuationObserver) =>
      f.service.bulkUpdateResourcePermissions({ ...f.args, observer }),
    );
    const outcome = rejectsWith(original, 'roles failed');
    await flush();
    expect((await census(owner)).queuedContinuations).toBe(1);
    expect(f.mutation.abortTransaction).not.toHaveBeenCalled();
    expect(f.mutation.endSession).not.toHaveBeenCalled();
    entries.resolve([]);
    await outcome;
    expect(f.mutation.abortTransaction).toHaveBeenCalledTimes(1);
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
    await flush();
    expect((await census(owner)).queuedContinuations).toBe(1);
    expect(f.mutation.endSession).toHaveBeenCalledTimes(1);
    end.reject(new Error('end failed'));
    await outcome;
    expect(f.methods.findRolesByResourceType).not.toHaveBeenCalled();
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
    await flush();
    expect(f.mutation.commitTransaction).toHaveBeenCalledTimes(1);
    expect(f.mutation.endSession).toHaveBeenCalledTimes(1);
    expect((await census(owner)).queuedContinuations).toBe(1);
    end.reject(new Error('only end failed'));
    await outcome;
    expect(f.mutation.abortTransaction).not.toHaveBeenCalled();
    expect((await census(owner)).complete).toBe(false);
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
      await flush();
      expect(target).toHaveBeenCalledTimes(1);
      const state = await census(owner);
      expect(state.queuedContinuations).toBe(1);
      expect(state.pendingWrites).toBeGreaterThan(0);
      expect(f.mutation.commitTransaction).not.toHaveBeenCalled();
      gate.reject(new Error('write failed'));
      await outcome;
      expect((await census(owner)).complete).toBe(false);
    },
  );

  it('marks a rejected delete uncertain before its functional per-principal normalization', async () => {
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
    await flush();
    expect((await census(owner)).pendingWrites).toBeGreaterThan(0);
    gate.reject(new Error('delete failed'));
    const result = await original;
    expect(result.errors).toEqual([{ principal: f.principal, error: 'delete failed' }]);
    expect(f.mutation.commitTransaction).toHaveBeenCalledTimes(1);
    expect((await census(owner)).complete).toBe(false);
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
    await flush();
    expect((await census(owner)).pendingWrites).toBeGreaterThan(0);
    expect(f.connection.startSession).not.toHaveBeenCalled();
    gate.reject(new Error('compensation failed'));
    await outcome;
    expect((await census(owner)).complete).toBe(false);
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
        const ending = external.commitTransaction();
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
});
