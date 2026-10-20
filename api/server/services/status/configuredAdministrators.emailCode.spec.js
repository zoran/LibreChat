const mongoose = require('mongoose');
const { randomBytes } = require('node:crypto');
const express = require('express');
const request = require('supertest');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const {
  createModels,
  createMethods,
  runAsSystem,
  SystemCapabilities,
} = require('@librechat/data-schemas');
const { generateCapabilityCheck } = require('@librechat/api');
const { createStatusRouter } = require('./router');

/** Real transaction + composition + unchanged Status platformOnly capability owner. */
describe('configured administrator email-code and Status composition', () => {
  let mongo;
  let methods;
  const policy = {
    revision: 1,
    tenantId: 'cortex-bwi',
    emails: ['zoran.kikic@bwi.de', 'dennis.maier@bwi.de'],
  };
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    methods = createMethods(mongoose, { configuredAdministratorPolicy: policy });
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  }, 30_000);
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });
  beforeEach(async () => {
    await runAsSystem(async () => {
      // Audit append-only guards remain enabled; fixture cleanup uses the native collection.
      await Promise.all(
        Object.values(mongoose.models).map((model) => model.collection.deleteMany({})),
      );
    });
  });
  async function accepted(email, tenantId = policy.tenantId) {
    const c = {
      _id: randomBytes(32).toString('base64url'),
      tenantId,
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
    await methods.reserveEmailCodeAttempt({ challenge: c, now: new Date() });
    await methods.finishEmailCodeSend(c._id, 0, true);
    return c;
  }
  const redeem = (c) => ({
    attemptId: c._id,
    tenantId: c.tenantId,
    nonceHash: c.nonceHash,
    generation: c.generation,
    verifier: c.verifier,
    refreshTokenHash: '3'.repeat(64),
    sessionId: randomBytes(12).toString('hex'),
    policyVersion: 1,
    now: new Date(),
  });
  function status(identity) {
    const capabilities = generateCapabilityCheck(methods);
    const app = express();
    app.use(
      '/status',
      createStatusRouter({
        // This fixture enters after real successful redemption; JWT parsing is unchanged.
        requireJwtAuth: (req, _res, next) => {
          req.user = identity.user;
          next();
        },
        requireCapability: capabilities.requireCapability,
        hasCapability: capabilities.hasCapability,
        accessAdmin: SystemCapabilities.ACCESS_ADMIN,
        getSnapshot: async () => ({ body: '{"status":"ok"}', validUntilMs: Date.now() + 10_000 }),
      }),
    );
    return request(app);
  }
  it('commits a verified USER, global grant and audit before allowing Status', async () => {
    const identity = await methods.redeemEmailCode(redeem(await accepted(policy.emails[0])));
    expect(identity.user).toMatchObject({
      role: 'USER',
      tenantId: policy.tenantId,
      emailVerified: true,
    });
    const grant = await mongoose.models.SystemGrant.findOne({
      principalId: new mongoose.Types.ObjectId(identity.user.id),
    }).lean();
    expect(grant).toMatchObject({ capability: SystemCapabilities.ACCESS_ADMIN });
    expect(grant?.tenantId).toBeUndefined();
    expect(await mongoose.models.AuditLog.countDocuments({ action: 'grant.assigned' })).toBe(1);
    await status(identity).get('/status').expect(200);
    await status(identity).get('/status/access').expect(200, { allowed: true });
  });
  it('denies an ordinary verified user, including a tenant ADMIN role', async () => {
    const identity = await methods.redeemEmailCode(redeem(await accepted('ordinary@bwi.de')));
    await methods.seedSystemGrants();
    const ordinaryResponse = await status(identity).get('/status');
    expect(ordinaryResponse.status).toBe(403);
    const tenantAdminResponse = await status({
      ...identity,
      user: { ...identity.user, role: 'ADMIN' },
    }).get('/status');
    expect(tenantAdminResponse.status).toBe(403);
  });
  it('does not grant on a bad code and rejects replay without another grant/audit', async () => {
    const c = await accepted(policy.emails[0]);
    await expect(
      methods.redeemEmailCode({ ...redeem(c), verifier: '9'.repeat(64) }),
    ).rejects.toThrow('EMAIL_CODE_INVALID');
    expect(await mongoose.models.SystemGrant.countDocuments({})).toBe(0);
    expect(await mongoose.models.PlatformAdminPolicy.countDocuments({})).toBe(0);
    await methods.redeemEmailCode(redeem(c));
    await expect(methods.redeemEmailCode(redeem(c))).rejects.toThrow('EMAIL_CODE_INVALID');
    expect(await mongoose.models.SystemGrant.countDocuments({})).toBe(1);
    expect(await mongoose.models.AuditLog.countDocuments({ action: 'grant.assigned' })).toBe(1);
  });
  it('revokes Status on the next request and rolls back stale-replica redemption', async () => {
    const identity = await methods.redeemEmailCode(redeem(await accepted(policy.emails[0])));
    await status(identity).get('/status').expect(200);
    await methods.reconcileConfiguredAdministrators({ ...policy, revision: 2, emails: [] });
    await status(identity).get('/status').expect(403);
    await status(identity).get('/status/access').expect(200, { allowed: false });
    const c = await accepted(policy.emails[1]);
    await expect(methods.redeemEmailCode(redeem(c))).rejects.toThrow(
      'CONFIGURED_ADMIN_POLICY_STALE',
    );
    expect(
      await runAsSystem(() => mongoose.models.User.countDocuments({ email: policy.emails[1] })),
    ).toBe(0);
    expect(
      (await mongoose.models.EmailCodeChallenge.findById(c._id).lean())?.consumedAt,
    ).toBeUndefined();
    expect(await mongoose.models.SystemGrant.countDocuments({})).toBe(0);
  });
  it('rolls back the verified account, session, grant and policy if audit append fails', async () => {
    const c = await accepted(policy.emails[0]);
    const audit = jest
      .spyOn(mongoose.models.AuditLog.collection, 'insertOne')
      .mockRejectedValueOnce(new Error('AUDIT_STORAGE_UNAVAILABLE'));
    try {
      await expect(methods.redeemEmailCode(redeem(c))).rejects.toThrow();
    } finally {
      audit.mockRestore();
    }
    await runAsSystem(async () => {
      expect(await mongoose.models.User.countDocuments({})).toBe(0);
      expect(await mongoose.models.Session.countDocuments({})).toBe(0);
    });
    expect(await mongoose.models.SystemGrant.countDocuments({})).toBe(0);
    expect(await mongoose.models.PlatformAdminPolicy.countDocuments({})).toBe(0);
    expect(
      (await mongoose.models.EmailCodeChallenge.findById(c._id).lean())?.consumedAt,
    ).toBeUndefined();
  });
  it('rolls back a cross-tenant configured login and rejects lost managed configuration', async () => {
    const c = await accepted(policy.emails[0], 'other-tenant');
    await expect(methods.redeemEmailCode(redeem(c))).rejects.toThrow(
      'Configured administrator tenant mismatch',
    );
    expect(await runAsSystem(() => mongoose.models.User.countDocuments({}))).toBe(0);
    expect(await runAsSystem(() => mongoose.models.Session.countDocuments({}))).toBe(0);
    await methods.reconcileConfiguredAdministrators(policy);
    await expect(methods.assertConfiguredAdministratorPolicyPresence()).rejects.toThrow(
      'CONFIGURED_ADMIN_POLICY_REQUIRED',
    );
  });
});
