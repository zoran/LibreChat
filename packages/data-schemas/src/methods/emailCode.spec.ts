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
