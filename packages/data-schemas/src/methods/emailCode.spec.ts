import mongoose from 'mongoose';
import { randomBytes } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { EmailCodeChallenge } from '~/types/emailCode';
import { createSessionModel } from '~/models/session';
import { createBalanceModel } from '~/models/balance';
import { runAsSystem } from '~/config/tenantContext';
import { createEmailCodeMethods } from './emailCode';
import { createUserModel } from '~/models/user';

describe('email-code native transactional authority', () => {
  let mongo: MongoMemoryReplSet;
  let a: ReturnType<typeof createEmailCodeMethods>;
  let b: ReturnType<typeof createEmailCodeMethods>;

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongo.getUri());
    createUserModel(mongoose);
    createSessionModel(mongoose);
    createBalanceModel(mongoose);
    a = createEmailCodeMethods(mongoose);
    b = createEmailCodeMethods(mongoose);
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  }, 30_000);
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });
  beforeEach(async () => {
    await runAsSystem(async () => {
      await Promise.all(Object.values(mongoose.models).map((model) => model.deleteMany({})));
    });
  });

  function challenge(email = 'person@employees.example.test'): EmailCodeChallenge {
    return {
      _id: randomBytes(32).toString('base64url'),
      tenantId: 'cortex-bwi',
      email,
      mailboxKey: email,
      nonceHash: '1'.repeat(64),
      verifier: '2'.repeat(64),
      generation: 0,
      expiresAt: new Date(Date.now() + 600_000),
      resendAt: new Date(Date.now() + 60_000),
      accepted: false,
      failures: 0,
    };
  }
  async function accepted(email?: string) {
    const c = challenge(email);
    await a.reserveEmailCodeAttempt({ challenge: c, now: new Date() });
    await a.finishEmailCodeSend(c._id, c.generation, true);
    return c;
  }
  const redeem = (c: EmailCodeChallenge, verifier = c.verifier) => ({
    attemptId: c._id,
    tenantId: c.tenantId,
    nonceHash: c.nonceHash,
    generation: c.generation,
    verifier,
    refreshTokenHash: '3'.repeat(64),
    sessionId: randomBytes(12).toString('hex'),
    policyVersion: 1,
    now: new Date(),
  });

  it('creates the verified profile and90/270 day deadlines', async () => {
    const value = await a.redeemEmailCode(redeem(await accepted('marc.vonderlinden@bwi.de')));
    expect(value.user.name).toBe('Marc von der Linden');
    expect(value.grant.idleExpiresAt - value.grant.createdAt).toBe(90 * 86400000);
    expect(value.grant.absoluteExpiresAt - value.grant.createdAt).toBe(270 * 86400000);
  });

  it.each(['', '   ', 'Self Selected'])('fills only blank legacy names: %j', async (name) => {
    const email = 'anna-lena.mueller-schmidt@bwi.de';
    await runAsSystem(() =>
      mongoose.models.User.create({
        email,
        tenantId: 'cortex-bwi',
        provider: 'email_code',
        emailVerified: true,
        name,
      }),
    );
    const value = await a.redeemEmailCode(redeem(await accepted(email)));
    expect(value.user.name).toBe(name.trim() ? name : 'Anna-Lena Mueller-Schmidt');
  });

  it('preserves a custom name racing legacy fill', async () => {
    const email = 'marc.vonderlinden@bwi.de';
    const user = await runAsSystem(() =>
      mongoose.models.User.create({
        email,
        tenantId: 'cortex-bwi',
        provider: 'email_code',
        emailVerified: true,
        name: '',
      }),
    );
    const c = await accepted(email);
    await Promise.all([
      a.redeemEmailCode(redeem(c)),
      runAsSystem(() =>
        mongoose.models.User.updateOne({ _id: user._id }, { $set: { name: 'My chosen name' } }),
      ),
    ]);
    expect((await runAsSystem(() => mongoose.models.User.findById(user._id).lean())).name).toBe(
      'My chosen name',
    );
  });

  it('refresh/read do not extend idle and a foreground touch retains original absolute cap', async () => {
    const value = await a.redeemEmailCode(redeem(await accepted()));
    await b.readEmailCodeIdentity(value.grant.sessionId, 'cortex-bwi');
    await a.rotateEmailCodeRefresh({
      grant: value.grant,
      oldHash: '3'.repeat(64),
      newHash: '4'.repeat(64),
      now: new Date(),
    });
    expect(
      (await b.readEmailCodeIdentity(value.grant.sessionId, 'cortex-bwi'))?.grant.idleExpiresAt,
    ).toBe(value.grant.idleExpiresAt);
    const oldCap = Date.now() + 12 * 3600000;
    await runAsSystem(() =>
      mongoose.models.Session.updateOne(
        { _id: value.grant.sessionId },
        { $set: { expiration: new Date(oldCap), idleExpiresAt: new Date(Date.now() + 3600000) } },
      ),
    );
    const old = (await b.readEmailCodeIdentity(value.grant.sessionId, 'cortex-bwi'))!;
    await a.touchEmailCodeSession(old.grant, new Date());
    const current = (await b.readEmailCodeIdentity(value.grant.sessionId, 'cortex-bwi'))!;
    expect(current.grant.absoluteExpiresAt).toBe(oldCap);
    expect(current.grant.idleExpiresAt).toBe(oldCap);
    await runAsSystem(() =>
      mongoose.models.Session.updateOne(
        { _id: value.grant.sessionId },
        { $set: { expiration: new Date(0) } },
      ),
    );
    await a.touchEmailCodeSession(current.grant, new Date());
    expect(await b.readEmailCodeIdentity(value.grant.sessionId, 'cortex-bwi')).toBeNull();
    await expect(
      a.rotateEmailCodeRefresh({
        grant: current.grant,
        oldHash: '4'.repeat(64),
        newHash: '5'.repeat(64),
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'REFRESH_REPLACED' });
  });

  it('rejects exact idle and absolute boundaries without resurrection', async () => {
    const value = await a.redeemEmailCode(redeem(await accepted()));
    const clock = jest.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(value.grant.idleExpiresAt - 1);
      expect(await b.readEmailCodeIdentity(value.grant.sessionId, 'cortex-bwi')).not.toBeNull();
      clock.mockReturnValue(value.grant.idleExpiresAt);
      expect(await b.readEmailCodeIdentity(value.grant.sessionId, 'cortex-bwi')).toBeNull();
      await a.touchEmailCodeSession(value.grant, new Date(value.grant.idleExpiresAt));
      expect(await b.readEmailCodeIdentity(value.grant.sessionId, 'cortex-bwi')).toBeNull();
      await runAsSystem(() =>
        mongoose.models.Session.updateOne(
          { _id: value.grant.sessionId },
          { $set: { idleExpiresAt: new Date(value.grant.absoluteExpiresAt + 86400000) } },
        ),
      );
      clock.mockReturnValue(value.grant.absoluteExpiresAt - 1);
      expect(await b.readEmailCodeIdentity(value.grant.sessionId, 'cortex-bwi')).not.toBeNull();
      clock.mockReturnValue(value.grant.absoluteExpiresAt);
      expect(await b.readEmailCodeIdentity(value.grant.sessionId, 'cortex-bwi')).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it('commits one consume and one USER identity under concurrent proof', async () => {
    const c = await accepted();
    const results = await Promise.allSettled([
      a.redeemEmailCode(redeem(c)),
      b.redeemEmailCode(redeem(c)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await runAsSystem(async () => {
      expect(
        await mongoose.models.User.countDocuments({ role: 'USER', provider: 'email_code' }),
      ).toBe(1);
      expect(await mongoose.models.User.countDocuments({ role: 'ADMIN' })).toBe(0);
      expect(await mongoose.models.Session.countDocuments()).toBe(1);
    });
  });

  it('commits wrong-guess accounting and locks the generation after five attempts', async () => {
    const c = await accepted();
    for (let n = 0; n < 5; n++) {
      await expect(b.redeemEmailCode(redeem(c, '4'.repeat(64)))).rejects.toMatchObject({
        code: 'EMAIL_CODE_INVALID',
      });
    }
    await expect(a.redeemEmailCode(redeem(c))).rejects.toMatchObject({
      code: 'EMAIL_CODE_INVALID',
    });
    expect((await a.getEmailCodeChallenge(c._id, c.tenantId))?.failures).toBe(5);
  });

  it('enforces the shared mailbox cooldown without replacing another browser attempt', async () => {
    const c = await accepted();
    await expect(
      b.reserveEmailCodeAttempt({ challenge: challenge(), now: new Date() }),
    ).rejects.toMatchObject({ code: 'EMAIL_CODE_THROTTLED' });
    await expect(a.redeemEmailCode(redeem(c))).resolves.toMatchObject({ user: { email: c.email } });
  });

  it('refuses an inactive send, tenant mismatch and a hidden account-deletion fence', async () => {
    const c = challenge();
    await a.reserveEmailCodeAttempt({ challenge: c, now: new Date() });
    await expect(a.redeemEmailCode(redeem(c))).rejects.toMatchObject({
      code: 'EMAIL_CODE_INVALID',
    });
    expect(await b.getEmailCodeChallenge(c._id, 'other-tenant')).toBeNull();
    await a.finishEmailCodeSend(c._id, c.generation, true);
    const identity = await a.redeemEmailCode(redeem(c));
    await runAsSystem(async () => {
      await mongoose.models.User.updateOne(
        { _id: identity.user.id },
        { $set: { agentTriggerDeletionStartedAt: new Date() } },
      );
    });
    expect(await b.readEmailCodeIdentity(identity.grant.sessionId, 'cortex-bwi')).toBeNull();
  });

  it('allows one refresh successor and observes acknowledged session/account revocation', async () => {
    const c = await accepted();
    const identity = await a.redeemEmailCode(redeem(c));
    const rotate = (newHash: string) => ({
      grant: identity.grant,
      oldHash: '3'.repeat(64),
      newHash,
      now: new Date(),
    });
    const results = await Promise.allSettled([
      a.rotateEmailCodeRefresh(rotate('4'.repeat(64))),
      b.rotateEmailCodeRefresh(rotate('5'.repeat(64))),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await a.readEmailCodeIdentity(identity.grant.sessionId, 'another-tenant')).toBeNull();
    await a.revokeEmailCodeAccount(identity.user.id, 'cortex-bwi');
    expect(await b.readEmailCodeIdentity(identity.grant.sessionId, 'cortex-bwi')).toBeNull();
    await runAsSystem(async () => {
      const user = await mongoose.models.User.findById(identity.user.id).lean();
      expect(user).toMatchObject({ authVersion: 1, credentialsChangedAt: expect.any(Date) });
    });
    const other = await a.redeemEmailCode(redeem(await accepted('other@partners.example.test')));
    await a.revokeEmailCodeSession(other.grant.sessionId, other.user.id, other.grant.tenantId);
    expect(await b.readEmailCodeIdentity(other.grant.sessionId, 'cortex-bwi')).toBeNull();
  });

  it('does not resurrect expired grants through activity or refresh', async () => {
    const identity = await a.redeemEmailCode(redeem(await accepted()));
    await runAsSystem(async () => {
      await mongoose.models.Session.updateOne(
        { _id: identity.grant.sessionId },
        { $set: { idleExpiresAt: new Date(0) } },
      );
    });
    await a.touchEmailCodeSession(identity.grant, new Date());
    expect(await b.readEmailCodeIdentity(identity.grant.sessionId, 'cortex-bwi')).toBeNull();
    await expect(
      a.rotateEmailCodeRefresh({
        grant: identity.grant,
        oldHash: '3'.repeat(64),
        newHash: '4'.repeat(64),
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'REFRESH_REPLACED' });
  });
});
