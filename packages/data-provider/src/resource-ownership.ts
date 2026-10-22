/** Server authorization context only. This is not a persisted File or retrieval wire migration. */
import { z } from 'zod';

const userId = z.string().min(1).max(128);
const tenantId = z
  .string()
  .regex(/^[a-zA-Z0-9_.-]{1,128}$/)
  .refine((value) => value !== '__SYSTEM__');
const personalScope = z.object({ kind: z.literal('personal') }).strict();
const workspaceScope = z
  .object({
    kind: z.literal('workspace'),
    /** Existing ChatProject ObjectId; never a second workspace identity. */
    workspaceId: z.string().regex(/^[a-f0-9]{24}$/),
  })
  .strict();

export const resourceScopeSchema = z.union([personalScope, workspaceScope]);
export type ResourceScope = z.infer<typeof resourceScopeSchema>;

/** Null names an exact historical personal namespace; current authentication remains upstream. */
export const resourcePrincipalSchema = z.object({ tenantId: tenantId.nullable(), userId }).strict();
export type ResourcePrincipal = z.infer<typeof resourcePrincipalSchema>;
export const resourceOwnerSchema = z.union([
  z.object({ tenantId: tenantId.nullable(), scope: personalScope, ownerUserId: userId }).strict(),
  z.object({ tenantId, scope: workspaceScope }).strict(),
]);
export type ResourceOwner = z.infer<typeof resourceOwnerSchema>;
/** Immutable attribution, deliberately absent from authorization decisions. */
export type ResourceProvenance = Readonly<{ createdBy: ResourcePrincipal }>;

export const resourceActionSchema = z.enum([
  'read',
  'upload',
  'contribute',
  'change',
  'remove',
  'share',
  'administer',
]);
export type ResourceAction = z.infer<typeof resourceActionSchema>;
export const resourceAuthorizationRequestSchema = z
  .object({
    owner: resourceOwnerSchema,
    resourceType: z.enum(['upload', 'file', 'chatProject', 'conversation']),
    /** Null binds a collection request; it never authorizes a particular source. */
    resourceId: z.string().min(1).max(256).nullable(),
    action: resourceActionSchema,
  })
  .strict()
  .refine((value) => value.resourceId !== null || ['read', 'upload'].includes(value.action))
  .refine(
    (value) =>
      value.resourceType !== 'chatProject' ||
      value.owner.scope.kind !== 'workspace' ||
      value.resourceId === value.owner.scope.workspaceId,
  );
export type ResourceAuthorizationRequest = z.infer<typeof resourceAuthorizationRequestSchema>;

/** Server-selected intended recipients. This does not grant access or expand saved audiences. */
export const resourceAudienceSchema = z
  .array(resourcePrincipalSchema)
  .min(1)
  .max(256)
  .refine(
    (values) =>
      new Set(values.map((value) => JSON.stringify([value.tenantId, value.userId]))).size ===
      values.length,
  );
export type ResourceAudience = readonly ResourcePrincipal[];
