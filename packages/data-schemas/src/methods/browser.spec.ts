import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createBrowserMethods } from './browser';
import { createSessionMethods } from './session';
import balanceSchema from '~/schema/balance';
import sessionSchema from '~/schema/session';
import { createUserMethods } from './user';
import userSchema from '~/schema/user';

describe('browser enrollment in native User/Session storage', () => {
  let mongo: MongoMemoryReplSet;
  let methods: ReturnType<typeof createBrowserMethods>;
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongo.getUri(), { monitorCommands: true });
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
    expect(await methods.findBrowserIdentity(a.credential)).toMatchObject({
      user: a.user,
      expiration: expiry,
      sessionId: expect.stringMatching(/^[a-f0-9]{24}$/),
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

  it('rejects disabled and credential-retired guest sessions through the current native owner', async () => {
    const issued = await methods.enrollBrowserIdentity(new Date(Date.now() + 60_000));
    await mongoose.models.User.updateOne({ _id: issued.user.id }, { authDisabled: true });
    expect(await methods.findBrowserIdentity(issued.credential)).toBeNull();
    await mongoose.models.User.updateOne(
      { _id: issued.user.id },
      { authDisabled: false, credentialsChangedAt: new Date(Date.now() + 1000) },
    );
    expect(await methods.findBrowserIdentity(issued.credential)).toBeNull();
  });

  it('does not announce an unacknowledged account-deletion fence as acquired', async () => {
    const issued = await methods.enrollBrowserIdentity(new Date(Date.now() + 60000));
    const update = jest
      .spyOn(mongoose.models.User, 'updateOne')
      .mockResolvedValueOnce({ acknowledged: false, modifiedCount: 1 } as never);
    try {
      await expect(
        createUserMethods(mongoose).beginAgentTriggerUserDeletion(issued.user.id, new Date()),
      ).rejects.toThrow();
    } finally {
      update.mockRestore();
    }
  });

  it('binds a real native guest cookie and signed bearer through the public auth port until confirmed revocation', async () => {
    const { validateBrowserBearer, BROWSER_COOKIE } = await import('@librechat/api');
    const previous = { ...process.env };
    const commands: { commandName: string; command: Record<string, unknown> }[] = [];
    const observe = (event: { commandName: string; command: Record<string, unknown> }) =>
      commands.push(event);
    process.env.AUTH_MODE = 'transition';
    process.env.CORTEX_UPLOAD_GUEST_TRANSITION_ENABLED = 'true';
    process.env.JWT_SECRET = 'isolated-guest-token';
    try {
      const a = await methods.enrollBrowserIdentity(new Date(Date.now() + 60000));
      const b = await methods.enrollBrowserIdentity(new Date(Date.now() + 60000));
      const bearer = (id: string) =>
        jwt.verify(
          jwt.sign({ id, provider: 'browser' }, process.env.JWT_SECRET, { expiresIn: 60 }),
          process.env.JWT_SECRET,
          { algorithms: ['HS256'] },
        );
      const req = {
        headers: { cookie: `${BROWSER_COOKIE}=${a.credential}` },
        cookies: { [BROWSER_COOKIE]: a.credential },
      };
      mongoose.connection.getClient().on('commandStarted', observe);
      expect(await validateBrowserBearer(bearer(a.user.id), req, methods)).toMatchObject({
        grant: { userId: a.user.id, tenantId: null, sessionId: expect.any(String) },
      });
      expect(await validateBrowserBearer(bearer(b.user.id), req, methods)).toBeNull();
      const reads = commands.filter((event) => event.commandName === 'find');
      expect(reads).toHaveLength(2);
      for (const event of reads)
        expect(event.command).toMatchObject({
          readConcern: { level: 'linearizable' },
          maxTimeMS: 2000,
        });
      await methods.revokeBrowserIdentity(a.credential);
      expect(await validateBrowserBearer(bearer(a.user.id), req, methods)).toBeNull();
      expect(commands.find((event) => event.commandName === 'delete')?.command).toMatchObject({
        writeConcern: { w: 'majority', wtimeout: 2000 },
      });
    } finally {
      mongoose.connection.getClient().off('commandStarted', observe);
      process.env = previous;
    }
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
