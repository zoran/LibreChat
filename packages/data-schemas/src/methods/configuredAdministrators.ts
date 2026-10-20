import { createHash } from 'node:crypto';
import { PrincipalType } from 'librechat-data-provider';
import type { ClientSession, Model } from 'mongoose';
import type {
  ConfiguredAdministratorPolicy,
  PlatformAdminPolicy,
} from '~/types/platformAdminPolicy';
import type { ISystemGrant } from '~/types/systemGrant';
import type { AuditLogMethods } from './auditLog';
import type { IUser } from '~/types/user';
import { SystemCapabilities } from '~/admin/capabilities';
import { createSystemGrantMethods } from './systemGrant';
import { runAsSystem } from '~/config/tenantContext';

export const CONFIGURED_ADMINISTRATOR_POLICY_ID = 'configured-platform-administrators' as const;
export const MAX_CONFIGURED_ADMINISTRATORS = 64;
const CAPABILITY = SystemCapabilities.ACCESS_ADMIN;
const QUERY_MS = 2_000;

export interface ConfiguredAdministratorResult {
  revision: number;
  digest: string;
  granted: number;
  revoked: number;
}

export interface ConfiguredAdministratorMethods {
  reconcileConfiguredAdministrators(
    policy: ConfiguredAdministratorPolicy,
    options?: { session?: ClientSession },
  ): Promise<ConfiguredAdministratorResult>;
  assertConfiguredAdministratorPolicyPresence(
    policy?: ConfiguredAdministratorPolicy,
  ): Promise<void>;
}

/** Snapshot before awaiting: caller mutation must not change a policy being reconciled. */
function snapshotPolicy(input: ConfiguredAdministratorPolicy) {
  if (
    !input ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    typeof input.tenantId !== 'string' ||
    !/^[a-zA-Z0-9_.-]{1,128}$/.test(input.tenantId) ||
    input.tenantId === '__SYSTEM__' ||
    !Array.isArray(input.emails) ||
    input.emails.length > MAX_CONFIGURED_ADMINISTRATORS ||
    input.emails.some(
      (email) =>
        typeof email !== 'string' ||
        email.length > 254 ||
        email !== email.trim() ||
        !/^[a-z0-9][a-z0-9._+-]*@[a-z0-9.-]+\.[a-z]{2,63}$/.test(email),
    ) ||
    new Set(input.emails).size !== input.emails.length
  ) {
    throw new Error('CONFIGURED_ADMIN_POLICY_INVALID');
  }
  const emails = [...input.emails].sort();
  const digest = createHash('sha256')
    .update(JSON.stringify({ schemaVersion: 1, tenantId: input.tenantId, emails }))
    .digest('hex');
  return { revision: input.revision, tenantId: input.tenantId, emails, digest };
}

/**
 * Existing User/SystemGrant/AuditLog composition owns this finite control-plane transaction.
 * No authentication, account creation, role change or application-tenant bypass is performed.
 */
export function createConfiguredAdministratorMethods(
  mongoose: typeof import('mongoose'),
  { recordAuditEntry }: Pick<AuditLogMethods, 'recordAuditEntry'>,
): ConfiguredAdministratorMethods {
  const Policy = mongoose.models.PlatformAdminPolicy as Model<PlatformAdminPolicy>;
  const Grant = mongoose.models.SystemGrant as Model<ISystemGrant>;
  const User = mongoose.models.User as Model<IUser>;
  const Audit = mongoose.models.AuditLog;
  if (!Policy || !Grant || !User || !Audit || typeof recordAuditEntry !== 'function') {
    throw new Error('CONFIGURED_ADMIN_MODELS_REQUIRED');
  }
  const grants = createSystemGrantMethods(mongoose);
  let indexes: Promise<unknown> | undefined;
  const ensureIndexes = () =>
    (indexes ??= Promise.all(
      [Policy, Grant, User, Audit].map(async (model) => {
        await model.init();
        await model.createIndexes();
      }),
    ).catch((error) => {
      indexes = undefined;
      throw error;
    }));

  async function assertConfiguredAdministratorPolicyPresence(
    policy?: ConfiguredAdministratorPolicy,
  ): Promise<void> {
    if (policy !== undefined) {
      snapshotPolicy(policy);
    } else if (
      await Policy.exists({ _id: CONFIGURED_ADMINISTRATOR_POLICY_ID }).maxTimeMS(QUERY_MS)
    ) {
      throw new Error('CONFIGURED_ADMIN_POLICY_REQUIRED');
    }
  }

  async function reconcileConfiguredAdministrators(
    input: ConfiguredAdministratorPolicy,
    { session: suppliedSession }: { session?: ClientSession } = {},
  ): Promise<ConfiguredAdministratorResult> {
    const policy = snapshotPolicy(input);
    await ensureIndexes();
    const reconcile = async (session: ClientSession) => {
      if (!session.inTransaction()) throw new Error('CONFIGURED_ADMIN_TRANSACTION_REQUIRED');
      const current = await Policy.findById(CONFIGURED_ADMINISTRATOR_POLICY_ID)
        .session(session)
        .maxTimeMS(QUERY_MS)
        .lean();
      if (!current) {
        if (policy.revision !== 1) throw new Error('CONFIGURED_ADMIN_INITIAL_REVISION_REQUIRED');
        await Policy.create(
          [{ _id: CONFIGURED_ADMINISTRATOR_POLICY_ID, ...policy, writeSequence: 1 }],
          { session },
        );
      } else {
        if (policy.revision < current.revision) throw new Error('CONFIGURED_ADMIN_POLICY_STALE');
        if (policy.revision === current.revision && policy.digest !== current.digest) {
          throw new Error('CONFIGURED_ADMIN_POLICY_CONFLICT');
        }
        if (
          !Number.isSafeInteger(current.writeSequence) ||
          current.writeSequence >= Number.MAX_SAFE_INTEGER
        ) {
          throw new Error('CONFIGURED_ADMIN_POLICY_FENCE_EXHAUSTED');
        }
        // A write on every call serializes old/new replicas even when no grants change.
        const fenced = await Policy.updateOne(
          {
            _id: current._id,
            revision: current.revision,
            digest: current.digest,
            writeSequence: current.writeSequence,
          },
          { $set: policy, $inc: { writeSequence: 1 } },
          { session },
        );
        if (fenced.matchedCount !== 1) throw new Error('CONFIGURED_ADMIN_POLICY_CONFLICT');
      }

      const users = await runAsSystem(async () =>
        User.find({
          tenantId: policy.tenantId,
          email: { $in: policy.emails },
          provider: 'email_code',
          emailVerified: true,
          authDisabled: { $ne: true },
          agentTriggerDeletionStartedAt: null,
        })
          .select('_id email tenantId')
          .limit(MAX_CONFIGURED_ADMINISTRATORS + 1)
          .session(session)
          .maxTimeMS(QUERY_MS)
          .lean(),
      );
      if (
        users.length > MAX_CONFIGURED_ADMINISTRATORS ||
        new Set(users.map((u) => u.email)).size !== users.length
      ) {
        throw new Error('CONFIGURED_ADMIN_IDENTITY_CONFLICT');
      }
      const eligible = new Map(users.map((user) => [String(user._id), user]));
      const owned = await Grant.find({ 'managedBy.owner': CONFIGURED_ADMINISTRATOR_POLICY_ID })
        .limit(MAX_CONFIGURED_ADMINISTRATORS + 1)
        .session(session)
        .maxTimeMS(QUERY_MS)
        .lean();
      if (owned.length > MAX_CONFIGURED_ADMINISTRATORS) {
        throw new Error('CONFIGURED_ADMIN_OWNERSHIP_INVALID');
      }
      let granted = 0;
      let revoked = 0;
      const audit = async (
        action: 'grant.assigned' | 'grant.removed',
        userId: string,
        identityTenantId: string,
      ) => {
        const record = await recordAuditEntry(
          {
            action,
            actor: {
              type: 'system',
              id: CONFIGURED_ADMINISTRATOR_POLICY_ID,
              name: 'Configured administrators',
            },
            target: { type: PrincipalType.USER, id: userId },
            metadata: {
              capability: CAPABILITY,
              policyRevision: policy.revision,
              policyDigest: policy.digest,
              identityTenantId,
            },
          },
          { failClosed: true, session },
        );
        if (!record) throw new Error('CONFIGURED_ADMIN_AUDIT_REQUIRED');
      };
      for (const grant of owned) {
        if (
          grant.principalType !== PrincipalType.USER ||
          grant.capability !== CAPABILITY ||
          grant.tenantId !== undefined ||
          !grant.managedBy ||
          typeof grant.managedBy.tenantId !== 'string' ||
          !grant.managedBy.tenantId
        ) {
          throw new Error('CONFIGURED_ADMIN_OWNERSHIP_INVALID');
        }
        const userId = String(grant.principalId);
        const user = eligible.get(userId);
        if (
          user &&
          grant.managedBy?.tenantId === policy.tenantId &&
          grant.managedBy.email === user.email
        )
          continue;
        const removed = await grants.revokeCapability(
          {
            principalType: PrincipalType.USER,
            principalId: grant.principalId,
            capability: CAPABILITY,
            managedByOwner: CONFIGURED_ADMINISTRATOR_POLICY_ID,
          },
          session,
        );
        if (removed.deletedCount !== 1) throw new Error('CONFIGURED_ADMIN_OWNERSHIP_CONFLICT');
        await audit('grant.removed', userId, grant.managedBy.tenantId);
        revoked++;
      }
      for (const user of users) {
        const added = await grants.grantCapability(
          {
            principalType: PrincipalType.USER,
            principalId: user._id,
            capability: CAPABILITY,
            managedBy: {
              owner: CONFIGURED_ADMINISTRATOR_POLICY_ID,
              tenantId: policy.tenantId,
              email: user.email,
              revision: policy.revision,
              digest: policy.digest,
            },
          },
          session,
        );
        if (added.created) {
          await audit('grant.assigned', String(user._id), policy.tenantId);
          granted++;
        }
      }
      return { revision: policy.revision, digest: policy.digest, granted, revoked };
    };
    if (suppliedSession) return reconcile(suppliedSession);
    // Bootstrap's unique policy row can race before either transaction sees it.
    for (let attempt = 0; ; attempt++) {
      try {
        return await mongoose.connection.transaction(reconcile, {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          readPreference: 'primary',
          maxCommitTimeMS: QUERY_MS,
        });
      } catch (error) {
        if ((error as { code?: number }).code !== 11000 || attempt >= 2) throw error;
      }
    }
  }
  return { reconcileConfiguredAdministrators, assertConfiguredAdministratorPolicyPresence };
}
