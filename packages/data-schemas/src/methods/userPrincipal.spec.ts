import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createModels } from '~/models';
import { tenantStorage } from '~/config/tenantContext';
import { createUserMethods } from './user';
import { touchActiveUserPrincipal, touchDeletingUserPrincipal } from './userPrincipal';

describe('native transactional User principal fence', () => {
  const db = new mongoose.Mongoose();
  const owner = { userId: new mongoose.Types.ObjectId().toString(), tenantId: 'tenant.test' };
  let mongo: MongoMemoryReplSet;
  const unavailable = { code: 'principal_unavailable' };
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      replSet: { count: 1 },
      binary: {
        version: '7.0.43',
        systemBinary:
          '/home/nodex/.local/share/nodex/tools/mongodb/7.0.43-ubuntu2204-linux-amd64/mongod',
      },
    });
    await db.connect(mongo.getUri('user-principal'));
    createModels(db);
    await db.models.User.init();
  });
  beforeEach(async () => {
    await db.models.User.deleteMany({});
    await db.models.User.create({
      _id: owner.userId,
      tenantId: owner.tenantId,
      email: 'principal@example.test',
      emailVerified: true,
    });
  });
  afterAll(async () => {
    await db.disconnect();
    await mongo?.stop();
  });
  async function transaction(work: (session: mongoose.ClientSession) => Promise<void>) {
    const session = await db.startSession();
    try {
      await session.withTransaction(() => work(session));
    } finally {
      await session.endSession();
    }
  }
  it('writes the existing version atomically without touching authentication or timestamps', async () => {
    const before = await db.models.User.findById(owner.userId).lean();
    await transaction((session) => touchActiveUserPrincipal(db, owner, session));
    const after = await db.models.User.findById(owner.userId).lean();
    expect(after).toMatchObject({
      __v: before!.__v + 1,
      authVersion: before!.authVersion,
      updatedAt: before!.updatedAt,
    });
    await expect(
      transaction(async (session) => {
        await touchActiveUserPrincipal(db, owner, session);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect((await db.models.User.findById(owner.userId).lean())!.__v).toBe(after!.__v);
  });
  it('rejects absent transactions and cross-tenant identities before writing', async () => {
    const session = await db.startSession();
    try {
      await expect(touchActiveUserPrincipal(db, owner, session)).rejects.toMatchObject(unavailable);
    } finally {
      await session.endSession();
    }
    await expect(
      transaction((session) =>
        touchActiveUserPrincipal(db, { ...owner, tenantId: 'other' }, session),
      ),
    ).rejects.toMatchObject(unavailable);
    await expect(
      tenantStorage.run({ tenantId: owner.tenantId }, () =>
        transaction((session) =>
          touchActiveUserPrincipal(db, { ...owner, tenantId: 'other' }, session),
        ),
      ),
    ).rejects.toMatchObject(unavailable);
  });
  it.each(['disabled', 'deleting', 'deleted'] as const)('rejects a %s account', async (state) => {
    if (state === 'deleted') await db.models.User.deleteOne({ _id: owner.userId });
    else
      await db.models.User.updateOne(
        { _id: owner.userId },
        {
          $set:
            state === 'disabled'
              ? { authDisabled: true }
              : { agentTriggerDeletionStartedAt: new Date() },
        },
      );
    await expect(
      transaction((session) => touchActiveUserPrincipal(db, owner, session)),
    ).rejects.toMatchObject(unavailable);
  });
  it('cannot commit admission from an old snapshot after native account deletion begins', async () => {
    const session = await db.startSession();
    try {
      session.startTransaction();
      await db.models.User.findById(owner.userId).session(session);
      expect(
        await createUserMethods(db).beginAgentTriggerUserDeletion(owner.userId, new Date()),
      ).toBe('acquired');
      await expect(touchActiveUserPrincipal(db, owner, session)).rejects.toMatchObject({
        code: 112,
      });
      await session.abortTransaction();
    } finally {
      await session.endSession();
    }
    await expect(
      transaction((session) => touchActiveUserPrincipal(db, owner, session)),
    ).rejects.toMatchObject(unavailable);
  });
  it('serializes an admitted transaction before the native deletion fence', async () => {
    const session = await db.startSession();
    try {
      session.startTransaction();
      await touchActiveUserPrincipal(db, owner, session);
      const deletion = createUserMethods(db).beginAgentTriggerUserDeletion(
        owner.userId,
        new Date(),
      );
      await session.commitTransaction();
      expect(await deletion).toBe('acquired');
    } finally {
      if (session.inTransaction()) await session.abortTransaction();
      await session.endSession();
    }
    await expect(
      transaction((next) => touchActiveUserPrincipal(db, owner, next)),
    ).rejects.toMatchObject(unavailable);
  });
  it('permits cleanup only for the exact native deletion attempt even when disabled', async () => {
    const startedAt = new Date();
    await db.models.User.updateOne(
      { _id: owner.userId },
      { $set: { authDisabled: true, agentTriggerDeletionStartedAt: startedAt } },
    );
    await transaction((session) => touchDeletingUserPrincipal(db, owner, startedAt, session));
    await expect(
      transaction((session) =>
        touchDeletingUserPrincipal(db, owner, new Date(startedAt.getTime() + 1), session),
      ),
    ).rejects.toMatchObject(unavailable);
    await db.models.User.updateOne(
      { _id: owner.userId },
      { $unset: { agentTriggerDeletionStartedAt: 1 } },
    );
    await expect(
      transaction((session) => touchDeletingUserPrincipal(db, owner, startedAt, session)),
    ).rejects.toMatchObject(unavailable);
  });
});
