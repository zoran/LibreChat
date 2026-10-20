import mongoose, { Types } from 'mongoose';
import { PrincipalType } from 'librechat-data-provider';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type {
  ConfiguredAdministratorPolicy,
  PlatformAdminPolicy,
} from '~/types/platformAdminPolicy';
import { createConfiguredAdministratorMethods } from './configuredAdministrators';
import platformAdminPolicySchema from '~/schema/platformAdminPolicy';
import { createSystemGrantModel } from '~/models/systemGrant';
import { SystemCapabilities } from '~/admin/capabilities';
import { createSystemGrantMethods } from './systemGrant';
import { createAuditLogModel } from '~/models/auditLog';
import { runAsSystem } from '~/config/tenantContext';
import { createAuditLogMethods } from './auditLog';
import { createUserModel } from '~/models/user';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

describe('configured administrator transactional authority', () => {
  let mongo: MongoMemoryReplSet;
  let User: ReturnType<typeof createUserModel>;
  let Grant: ReturnType<typeof createSystemGrantModel>;
  let Audit: ReturnType<typeof createAuditLogModel>;
  let Policy: mongoose.Model<PlatformAdminPolicy>;
  let audit: ReturnType<typeof createAuditLogMethods>;
  let owner: ReturnType<typeof createConfiguredAdministratorMethods>;
  let grants: ReturnType<typeof createSystemGrantMethods>;
  const email = 'operator@employees.example.test';
  const policy = (revision = 1, emails = [email]): ConfiguredAdministratorPolicy => ({
    revision,
    tenantId: 'cortex-bwi',
    emails,
  });
  const user = (over: Record<string, unknown> = {}) =>
    runAsSystem(async () =>
      User.create({
        email,
        tenantId: 'cortex-bwi',
        provider: 'email_code',
        emailVerified: true,
        role: 'USER',
        ...over,
      }),
    );
  const reconcile = (p = policy()) => owner.reconcileConfiguredAdministrators(p);
  const rows = () => Grant.find({ principalType: PrincipalType.USER }).lean();

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongo.getUri());
    User = createUserModel(mongoose);
    Grant = createSystemGrantModel(mongoose);
    Audit = createAuditLogModel(mongoose);
    Policy = mongoose.model('PlatformAdminPolicy', platformAdminPolicySchema);
    audit = createAuditLogMethods(mongoose);
    owner = createConfiguredAdministratorMethods(mongoose, audit);
    grants = createSystemGrantMethods(mongoose);
    await Promise.all([User, Grant, Audit, Policy].map((model) => model.init()));
  }, 30_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });

  beforeEach(async () => {
    await runAsSystem(async () => {
      await User.deleteMany({});
      await Grant.deleteMany({});
      await Policy.deleteMany({});
      await Audit.collection.deleteMany({});
    });
  });

  it('creates only an owned platform USER access grant and one real audit event', async () => {
    const account = await user();
    expect(await reconcile()).toMatchObject({ revision: 1, granted: 1, revoked: 0 });
    const [grant] = await rows();
    expect(grant).toMatchObject({
      principalType: PrincipalType.USER,
      principalId: account._id,
      capability: SystemCapabilities.ACCESS_ADMIN,
      managedBy: {
        owner: 'configured-platform-administrators',
        email,
        tenantId: 'cortex-bwi',
        revision: 1,
      },
    });
    expect(grant).not.toHaveProperty('tenantId');
    const current = await runAsSystem(async () => User.findById(account._id).lean());
    expect(current).toMatchObject({ role: 'USER', tenantId: 'cortex-bwi', emailVerified: true });
    expect(await Audit.findOne().lean()).toMatchObject({
      action: 'grant.assigned',
      actor: { type: 'system' },
      target: { type: 'user', id: String(account._id) },
      metadata: { policyRevision: 1, capability: 'access:admin' },
    });
    expect(
      await grants.hasCapabilityForPrincipals({
        principals: [{ principalType: PrincipalType.USER, principalId: account._id }],
        capability: SystemCapabilities.ACCESS_ADMIN,
      }),
    ).toBe(true);
  });

  it('records no invented account and grants an existing newly verified account on reconciliation', async () => {
    expect(await reconcile()).toMatchObject({ granted: 0, revoked: 0 });
    expect(await runAsSystem(async () => User.countDocuments())).toBe(0);
    await user();
    expect(await reconcile()).toMatchObject({ granted: 1 });
    expect(await reconcile()).toMatchObject({ granted: 0, revoked: 0 });
    expect(await Audit.countDocuments()).toBe(1);
  });

  it('keeps the ownership lookup independent of unrelated grant volume', async () => {
    await user();
    await reconcile();
    await Grant.insertMany(
      Array.from({ length: 1_000 }, (_, i) => ({
        principalType: PrincipalType.ROLE,
        principalId: `unrelated-role-${i}`,
        capability: SystemCapabilities.READ_USERS,
      })),
    );
    const plan = await Grant.find({ 'managedBy.owner': 'configured-platform-administrators' })
      .limit(65)
      .explain('executionStats');
    expect(plan).toMatchObject({ executionStats: { nReturned: 1, totalDocsExamined: 1 } });
  });

  it.each([
    { emailVerified: false },
    { provider: 'local' },
    { authDisabled: true },
    { tenantId: 'another-tenant' },
    { agentTriggerDeletionStartedAt: new Date() },
    { email: 'unlisted@employees.example.test', role: 'ADMIN' },
  ])('does not grant an ineligible identity %j', async (over) => {
    await user(over);
    expect(await reconcile()).toMatchObject({ granted: 0 });
    expect(await rows()).toHaveLength(0);
    expect(await Audit.countDocuments()).toBe(0);
  });

  it('revokes removed and disabled accounts while preserving manual and tenant grants', async () => {
    const account = await user();
    const unrelated = new Types.ObjectId();
    await grants.grantCapability({
      principalType: PrincipalType.USER,
      principalId: unrelated,
      capability: SystemCapabilities.ACCESS_ADMIN,
    });
    await grants.grantCapability({
      principalType: PrincipalType.USER,
      principalId: account._id,
      capability: SystemCapabilities.READ_USERS,
      tenantId: 'cortex-bwi',
    });
    await reconcile();
    expect(await reconcile(policy(2, []))).toMatchObject({ granted: 0, revoked: 1 });
    expect(await rows()).toHaveLength(2);
    expect(await Audit.countDocuments({ action: 'grant.removed' })).toBe(1);
    expect(await reconcile(policy(3))).toMatchObject({ granted: 1 });
    await runAsSystem(async () =>
      User.updateOne({ _id: account._id }, { $set: { authDisabled: true } }),
    );
    expect(await reconcile(policy(3))).toMatchObject({ revoked: 1 });
  });

  it('rejects manual-grant adoption and rolls back policy creation', async () => {
    const account = await user();
    await grants.grantCapability({
      principalType: PrincipalType.USER,
      principalId: account._id,
      capability: SystemCapabilities.ACCESS_ADMIN,
    });
    await expect(reconcile()).rejects.toThrow('CONFIGURED_ADMIN_GRANT_CONFLICT');
    expect(await Policy.countDocuments()).toBe(0);
    expect(await Audit.countDocuments()).toBe(0);
    expect((await rows())[0]).not.toHaveProperty('managedBy');
  });

  it('moves an explicit higher-revision tenant policy without misattributing revoked identities', async () => {
    const prior = await user();
    const next = await user({ tenantId: 'another-tenant' });
    await reconcile();
    expect(await reconcile({ ...policy(2), tenantId: 'another-tenant' })).toMatchObject({
      granted: 1,
      revoked: 1,
    });
    expect((await rows())[0].principalId).toEqual(next._id);
    expect(await Audit.findOne({ action: 'grant.removed' }).lean()).toMatchObject({
      target: { id: String(prior._id) },
      metadata: { identityTenantId: 'cortex-bwi', policyRevision: 2 },
    });
    expect(
      await Audit.findOne({ action: 'grant.assigned', 'metadata.policyRevision': 2 }).lean(),
    ).toMatchObject({
      target: { id: String(next._id) },
      metadata: { identityTenantId: 'another-tenant' },
    });
  });

  it('fences a stale replica and same-revision content changes', async () => {
    await user();
    await reconcile();
    await expect(reconcile(policy(1, []))).rejects.toThrow('CONFIGURED_ADMIN_POLICY_CONFLICT');
    await reconcile(policy(2, []));
    await expect(reconcile()).rejects.toThrow('CONFIGURED_ADMIN_POLICY_STALE');
    expect(await rows()).toHaveLength(0);
    expect(await Policy.findOne().lean()).toMatchObject({ revision: 2 });
  });

  it('binds the tenant into the digest and canonicalizes list order', async () => {
    const first = await reconcile(policy(1, [email, 'second@employees.example.test']));
    const second = await reconcile(policy(1, ['second@employees.example.test', email]));
    expect(second.digest).toBe(first.digest);
    await expect(reconcile({ ...policy(), tenantId: 'another-tenant' })).rejects.toThrow(
      'CONFIGURED_ADMIN_POLICY_CONFLICT',
    );
  });

  it('is idempotent across concurrent first-use owners and preserves the audit chain', async () => {
    await user();
    const peer = createConfiguredAdministratorMethods(mongoose, audit);
    const results = await Promise.all([
      reconcile(),
      peer.reconcileConfiguredAdministrators(policy()),
    ]);
    expect(results.reduce((n, value) => n + value.granted, 0)).toBe(1);
    expect(await rows()).toHaveLength(1);
    expect(await Audit.countDocuments()).toBe(1);
    expect(await audit.verifyAuditChain(undefined)).toMatchObject({ ok: true });
  });

  it('an old/new concurrent policy race cannot leave the removed grant', async () => {
    await user();
    await reconcile();
    const results = await Promise.allSettled([
      reconcile(policy(2, [])),
      reconcile(),
      reconcile(policy(2, [])),
    ]);
    for (const result of results) {
      if (result.status === 'rejected')
        expect(String(result.reason)).toContain('CONFIGURED_ADMIN_POLICY_STALE');
    }
    expect(await Policy.findOne().lean()).toMatchObject({ revision: 2 });
    expect(await rows()).toHaveLength(0);
    expect(await Audit.countDocuments({ action: 'grant.removed' })).toBe(1);
  });

  it('rolls back grant, revoke and policy revision when the real audit append fails', async () => {
    await user();
    const broken = createConfiguredAdministratorMethods(mongoose, {
      recordAuditEntry: async (input, options) => {
        await audit.recordAuditEntry(input, options);
        throw new Error('AUDIT_FAILURE_AFTER_INSERT');
      },
    });
    await expect(broken.reconcileConfiguredAdministrators(policy())).rejects.toThrow(
      'AUDIT_FAILURE',
    );
    expect(await Policy.countDocuments()).toBe(0);
    expect(await rows()).toHaveLength(0);
    expect(await Audit.countDocuments()).toBe(0);
    await reconcile();
    await expect(broken.reconcileConfiguredAdministrators(policy(2, []))).rejects.toThrow(
      'AUDIT_FAILURE',
    );
    expect(await Policy.findOne().lean()).toMatchObject({ revision: 1 });
    expect(await rows()).toHaveLength(1);
    expect(await Audit.countDocuments()).toBe(1);
  });

  it('joins the caller transaction so an aborted login leaves no account, grant or audit', async () => {
    await reconcile();
    await expect(
      mongoose.connection.transaction(async (session) => {
        await runAsSystem(async () =>
          User.create(
            [
              {
                email,
                tenantId: 'cortex-bwi',
                provider: 'email_code',
                emailVerified: true,
                role: 'USER',
              },
            ],
            { session },
          ),
        );
        expect(await owner.reconcileConfiguredAdministrators(policy(), { session })).toMatchObject({
          granted: 1,
        });
        throw new Error('LOGIN_ABORT');
      }),
    ).rejects.toThrow('LOGIN_ABORT');
    expect(await runAsSystem(async () => User.countDocuments())).toBe(0);
    expect(await rows()).toHaveLength(0);
    expect(await Audit.countDocuments()).toBe(0);
  });

  it('joins and commits the verified-account transaction with its exact grant and audit', async () => {
    await reconcile();
    await mongoose.connection.transaction(async (session) => {
      await runAsSystem(async () =>
        User.create(
          [
            {
              email,
              tenantId: 'cortex-bwi',
              provider: 'email_code',
              emailVerified: true,
              role: 'USER',
            },
          ],
          { session },
        ),
      );
      await owner.reconcileConfiguredAdministrators(policy(), { session });
    });
    expect(await rows()).toHaveLength(1);
    expect(await Audit.countDocuments()).toBe(1);
  });

  it('fails closed if configuration disappears after a managed policy exists', async () => {
    await expect(owner.assertConfiguredAdministratorPolicyPresence()).resolves.toBeUndefined();
    await reconcile();
    await expect(owner.assertConfiguredAdministratorPolicyPresence()).rejects.toThrow(
      'CONFIGURED_ADMIN_POLICY_REQUIRED',
    );
    await expect(
      owner.assertConfiguredAdministratorPolicyPresence(policy()),
    ).resolves.toBeUndefined();
  });

  it.each([
    { revision: 0 },
    { revision: 1.5 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { tenantId: '__SYSTEM__' },
    { emails: [email, email] },
    { emails: ['Operator@employees.example.test'] },
    { emails: [` ${email}`] },
    { emails: Array.from({ length: 65 }, (_, i) => `user${i}@employees.example.test`) },
    { emails: ['a'.repeat(245) + '@example.test'] },
  ])('rejects invalid policy before persistence %j', async (over) => {
    await expect(reconcile({ ...policy(), ...over })).rejects.toThrow(
      'CONFIGURED_ADMIN_POLICY_INVALID',
    );
    expect(await Policy.countDocuments()).toBe(0);
  });

  it('requires initial revision one and an active supplied transaction', async () => {
    await expect(reconcile(policy(2))).rejects.toThrow(
      'CONFIGURED_ADMIN_INITIAL_REVISION_REQUIRED',
    );
    const session = await mongoose.startSession();
    try {
      await expect(owner.reconcileConfiguredAdministrators(policy(), { session })).rejects.toThrow(
        'CONFIGURED_ADMIN_TRANSACTION_REQUIRED',
      );
    } finally {
      await session.endSession();
    }
  });
});
