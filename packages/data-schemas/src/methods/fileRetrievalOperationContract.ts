/** Shared File original-operation contract; validation and retained policy have one definition. */
import { z } from 'zod';
import {
  canonicalManagedJson,
  managedOwnerSchema,
  managedRevisionSchema,
} from 'librechat-data-provider';

export const id: z.ZodString = z.string().min(1).max(256);
export const digest: z.ZodString = z.string().regex(/^[a-f0-9]{64}$/);
export const integer: z.ZodNumber = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const purpose = z.enum(['index', 'query']);
export const purgeRequestSchema: z.ZodObject<
  { owner: typeof managedOwnerSchema; fileId: z.ZodString },
  'strict'
> = z.object({ owner: managedOwnerSchema, fileId: id }).strict();
export const requestSchema: z.ZodEffects<
  z.ZodObject<
    {
      owner: typeof managedOwnerSchema;
      operationId: z.ZodString;
      purpose: z.ZodEnum<['index', 'query']>;
      fileIds: z.ZodEffects<z.ZodArray<z.ZodString>>;
      body: z.ZodUnknown;
    },
    'strict'
  >
> = z
  .object({
    owner: managedOwnerSchema,
    operationId: id,
    purpose,
    fileIds: z
      .array(id)
      .min(1)
      .max(32)
      .refine((ids) => new Set(ids).size === ids.length),
    body: z.unknown(),
  })
  .strict()
  .refine(
    (value) => value.purpose !== 'index' || value.fileIds.length === 1,
    'An INDEX original owns exactly one File',
  );
export const policySchema: z.ZodObject<
  {
    backendIdentity: z.ZodString;
    routePolicySha256: z.ZodString;
    rankingPolicySha256: z.ZodNullable<z.ZodString>;
    indexGeneration: z.ZodString;
    writerEpoch: z.ZodNumber;
    provenanceSha256: z.ZodString;
  },
  'strict'
> = z
  .object({
    backendIdentity: id,
    routePolicySha256: digest,
    rankingPolicySha256: digest.nullable(),
    indexGeneration: digest,
    writerEpoch: integer,
    provenanceSha256: digest,
  })
  .strict();
export type FileRetrievalPolicy = z.infer<typeof policySchema>;
/** Existing provenance binds the trusted deployment/policy generation; no request supplies it. */
const policySnapshotSchema: z.ZodEffects<
  z.ZodObject<
    {
      version: z.ZodLiteral<1>;
      source: z.ZodObject<{ provenanceSha256: z.ZodString }, 'strict'>;
      content: typeof policySchema;
      purge: z.ZodArray<typeof policySchema>;
    },
    'strict'
  >
> = z
  .object({
    version: z.literal(1),
    source: z.object({ provenanceSha256: digest }).strict(),
    content: policySchema,
    purge: z.array(policySchema),
  })
  .strict()
  .superRefine((value, context) => {
    // Explicit retained cleanup policies keep their own original provenance across deployments.
    if (
      value.content.provenanceSha256 !== value.source.provenanceSha256 ||
      new Set(
        value.purge.map((policy) =>
          canonicalManagedJson([policy.backendIdentity, policy.writerEpoch]),
        ),
      ).size !== value.purge.length
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Ambiguous or unbound policy source',
      });
  });
export type FileRetrievalPolicySnapshot = z.infer<typeof policySnapshotSchema>;
/** Parse the same immutable deployment policy used by the File operation owner; no admission is issued. */
export function parseFileRetrievalPolicySnapshot(value: unknown): FileRetrievalPolicySnapshot {
  return policySnapshotSchema.parse(value);
}
export type FileRetrievalRequest = z.infer<typeof requestSchema>;
export type Source = {
  fileId: string;
  sourceRevision: string;
  representationRevision: string;
  expiresAt: number;
  /** Exact verified, content-free history in the same immutable original. Parallel to keys. */
  revisions: z.infer<typeof managedRevisionSchema>[];
  keys: { sourceRevision: string; representationRevision: string; indexGeneration: string }[];
};
export type FileRetrievalOriginal = {
  version: 1;
  owner: FileRetrievalRequest['owner'];
  operationId: string;
  purpose: FileRetrievalRequest['purpose'] | 'purge';
  cleanup?: { slotIds: string[]; planSha256: string; partition: number; partitions: number };
  bodySha256: string;
  policy: FileRetrievalPolicy;
  sources: Source[];
  /** File-owner timestamps are Unix epoch milliseconds, matching retained File expiries. */
  admittedAt: number;
  workDeadline: number;
  cleanupDeadline: number;
  originalSha256: string;
};
