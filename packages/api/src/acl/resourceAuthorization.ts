/** Current authorization reads through Identity/ACL ports; no membership store or production activation. */
import {
  resourceAudienceSchema,
  resourceAuthorizationRequestSchema,
  resourcePrincipalSchema,
} from 'librechat-data-provider';
import type {
  ResourceAction,
  ResourceAudience,
  ResourceAuthorizationRequest,
  ResourcePrincipal,
  TAccessLevel,
} from 'librechat-data-provider';

export interface ResourceAccessReader {
  /** Authenticated server/session owner, re-read at each use; browser claims are not authority. */
  isActive(principal: ResourcePrincipal): Promise<boolean>;
  /** Future adapter reads existing ACL entries for this tenant's ChatProject identity. */
  projectAccess(
    principal: ResourcePrincipal,
    projectId: string,
  ): Promise<{ level: TAccessLevel; revision: number } | null>;
}

const ACTION_LEVELS: Record<ResourceAction, readonly TAccessLevel[]> = {
  read: ['viewer', 'editor', 'owner'],
  upload: ['editor', 'owner'],
  contribute: ['editor', 'owner'],
  change: ['editor', 'owner'],
  remove: ['owner'],
  share: ['owner'],
  administer: ['owner'],
};

/** A point-in-time check, never a durable capability. Persistence/delivery must recheck and fence. */
export async function authorizeResource(
  actor: ResourcePrincipal,
  request: ResourceAuthorizationRequest,
  reader: ResourceAccessReader,
): Promise<boolean> {
  const principal = resourcePrincipalSchema.safeParse(actor);
  const input = resourceAuthorizationRequestSchema.safeParse(request);
  if (!principal.success || !input.success) return false;
  const { owner, action } = input.data;
  if (principal.data.tenantId !== owner.tenantId || !(await reader.isActive(principal.data)))
    return false;
  if (owner.scope.kind === 'personal')
    return 'ownerUserId' in owner && owner.ownerUserId === principal.data.userId;
  // Missing adapters deny. The caller must not turn an uploader id into workspace authority.
  if (principal.data.tenantId === null || typeof reader.projectAccess !== 'function') return false;
  const membership = await reader.projectAccess(principal.data, owner.scope.workspaceId);
  return (
    membership !== null &&
    Number.isSafeInteger(membership.revision) &&
    membership.revision >= 0 &&
    ACTION_LEVELS[action].includes(membership.level)
  );
}

/** Checks source reads for actor and every intended recipient; it does not authorize a shared run. */
export async function authorizeResourceAudience(
  actor: ResourcePrincipal,
  sources: readonly ResourceAuthorizationRequest[],
  audience: ResourceAudience,
  reader: ResourceAccessReader,
): Promise<boolean> {
  const principal = resourcePrincipalSchema.safeParse(actor);
  const recipients = resourceAudienceSchema.safeParse(audience);
  if (!principal.success || !recipients.success || sources.length < 1 || sources.length > 256)
    return false;
  // Snapshot caller-owned input before the first asynchronous access decision.
  const requests = sources.map((source) => resourceAuthorizationRequestSchema.safeParse(source));
  if (
    requests.some(
      (source) =>
        !source.success || source.data.action !== 'read' || source.data.resourceId === null,
    )
  )
    return false;
  for (const source of requests) {
    if (!source.success) return false;
    if (!(await authorizeResource(principal.data, source.data, reader))) return false;
    for (const recipient of recipients.data) {
      if (!(await authorizeResource(recipient, source.data, reader))) return false;
    }
  }
  return true;
}
