import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createBrowserMethods } from './browser';
import { createSessionMethods } from './session';
import balanceSchema from '~/schema/balance';
import sessionSchema from '~/schema/session';
import userSchema from '~/schema/user';

describe('browser enrollment in native User/Session storage', () => {
  let mongo: MongoMemoryReplSet;
  let methods: ReturnType<typeof createBrowserMethods>;
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongo.getUri());
    mongoose.model('User', userSchema);
    mongoose.model('Balance', balanceSchema);
    mongoose.model('Session', sessionSchema);
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
    methods = createBrowserMethods(mongoose);
  }, 25_000);
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });
  beforeEach(async () => {
    await Promise.all(Object.values(mongoose.models).map((model) => model.deleteMany({})));
  });

  it('creates distinct USER principals even when the database is empty', async () => {
    const expiry = new Date(Date.now() + 86_400_000);
    const [a, b] = await Promise.all([
      methods.enrollBrowserIdentity(expiry),
      methods.enrollBrowserIdentity(expiry),
    ]);
    expect(a.user.id).not.toBe(b.user.id);
    expect(a.user.role).toBe('USER');
    expect(a.user.provider).toBe('browser');
    expect(await mongoose.models.User.countDocuments({ role: 'ADMIN' })).toBe(0);
    const stored = await mongoose.models.Session.findOne({ user: a.user.id }).lean<{
      refreshTokenHash: string;
    }>();
    expect(stored?.refreshTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(a.credential);
    expect(await methods.findBrowserIdentity(a.credential)).toEqual({
      user: a.user,
      expiration: expiry,
    });
    expect(await methods.findBrowserIdentity(`${b.user.id}.${a.credential.slice(25)}`)).toBeNull();
  });

  it('preserves identity across parallel reads and native global revocation', async () => {
    const issued = await methods.enrollBrowserIdentity(new Date(Date.now() + 86_400_000));
    const otherReplica = createBrowserMethods(mongoose);
    const restored = await Promise.all([
      methods.findBrowserIdentity(issued.credential),
      otherReplica.findBrowserIdentity(issued.credential),
    ]);
    expect(restored.map((record) => record?.user.id)).toEqual([issued.user.id, issued.user.id]);
    await createSessionMethods(mongoose).deleteAllUserSessions(issued.user.id);
    expect(await otherReplica.findBrowserIdentity(issued.credential)).toBeNull();
  });

  it('rolls back principal and initial balance when session persistence fails', async () => {
    const failure = jest
      .spyOn(mongoose.models.Session, 'create')
      .mockRejectedValueOnce(new Error('injected'));
    await expect(
      methods.enrollBrowserIdentity(new Date(Date.now() + 60_000), {
        enabled: true,
        startBalance: 100,
      }),
    ).rejects.toThrow('injected');
    failure.mockRestore();
    expect(await mongoose.models.User.countDocuments()).toBe(0);
    expect(await mongoose.models.Balance.countDocuments()).toBe(0);
    expect(await mongoose.models.Session.countDocuments()).toBe(0);
  });

  it('rejects expired sessions, promoted users and deletion-fenced principals', async () => {
    const issued = await methods.enrollBrowserIdentity(new Date(Date.now() + 60_000));
    await mongoose.models.User.updateOne({ _id: issued.user.id }, { role: 'ADMIN' });
    expect(await methods.findBrowserIdentity(issued.credential)).toBeNull();
    await mongoose.models.User.updateOne(
      { _id: issued.user.id },
      { role: 'USER', agentTriggerDeletionStartedAt: new Date() },
    );
    expect(await methods.findBrowserIdentity(issued.credential)).toBeNull();
    await mongoose.models.User.updateOne(
      { _id: issued.user.id },
      { $unset: { agentTriggerDeletionStartedAt: 1 } },
    );
    await mongoose.models.Session.updateOne({ user: issued.user.id }, { expiration: new Date(0) });
    expect(await methods.findBrowserIdentity(issued.credential)).toBeNull();
  });
});
