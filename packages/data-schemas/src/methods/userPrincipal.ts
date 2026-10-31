import type { ClientSession } from 'mongoose';
import { currentTenantScope } from '../tenant/policy';

type UserPrincipal = Readonly<{ userId: string; tenantId: string | null }>;

export class UserPrincipalUnavailableError extends Error {
  readonly code = 'principal_unavailable';
  constructor() {
    super('principal_unavailable');
    this.name = 'UserPrincipalUnavailableError';
  }
}

function capturePrincipal(
  mongoose: typeof import('mongoose'),
  owner: UserPrincipal,
  session: ClientSession,
) {
  const userId = owner?.userId;
  const tenantId = owner?.tenantId;
  const scope = currentTenantScope();
  if (
    typeof userId !== 'string' ||
    !/^[a-fA-F0-9]{24}$/.test(userId) ||
    (tenantId !== null &&
      (typeof tenantId !== 'string' ||
        !/^[A-Za-z0-9_.-]{1,128}$/.test(tenantId) ||
        tenantId === '__SYSTEM__')) ||
    (scope.kind === 'scoped' && scope.tenantId !== tenantId) ||
    !(session instanceof mongoose.mongo.ClientSession) ||
    session.hasEnded ||
    !session.inTransaction() ||
    !mongoose.models.User
  )
    throw new UserPrincipalUnavailableError();
  return { _id: userId, tenantId };
}

/** Serializes the caller's transaction with native account deletion/disable writes. */
export async function touchActiveUserPrincipal(
  mongoose: typeof import('mongoose'),
  owner: UserPrincipal,
  session: ClientSession,
): Promise<void> {
  const identity = capturePrincipal(mongoose, owner, session);
  const result = await mongoose.models.User.updateOne(
    { ...identity, agentTriggerDeletionStartedAt: { $exists: false }, authDisabled: { $ne: true } },
    { $inc: { __v: 1 } },
    { session, timestamps: false, upsert: false },
  );
  if (!result.acknowledged || result.matchedCount !== 1) throw new UserPrincipalUnavailableError();
}

/** Cleanup joins the exact deletion attempt, including disabled accounts. */
export async function touchDeletingUserPrincipal(
  mongoose: typeof import('mongoose'),
  owner: UserPrincipal,
  startedAt: Date,
  session: ClientSession,
): Promise<void> {
  const identity = capturePrincipal(mongoose, owner, session);
  const timestamp = startedAt instanceof Date ? startedAt.getTime() : NaN;
  if (!Number.isFinite(timestamp)) throw new UserPrincipalUnavailableError();
  const result = await mongoose.models.User.updateOne(
    { ...identity, agentTriggerDeletionStartedAt: new Date(timestamp) },
    { $inc: { __v: 1 } },
    { session, timestamps: false, upsert: false },
  );
  if (!result.acknowledged || result.matchedCount !== 1) throw new UserPrincipalUnavailableError();
}
