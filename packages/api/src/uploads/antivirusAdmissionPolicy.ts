/** Normal client policy is produced by the existing AV profile owner and pinned on a readonly mount. */
import { z } from 'zod';
import { readAntivirusImmutableAsset } from './security/antivirus-process';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Exact immutable tuple issued by the normal AV profile owner, never a runtime ready flag. */
export interface NasAntivirusClientPolicy {
  schema: 1;
  image: string;
  sourceRevision: string;
  engineVersion: string;
  engineArtifactSha256: string;
  profileSha256: string;
  signatureManifestSha256: string;
  signatureVerificationSha256: string;
  signatureMaxAgeMs: number;
  slots: string[];
}
const schema: z.ZodType<NasAntivirusClientPolicy> = z
  .object({
    schema: z.literal(1),
    image: z
      .string()
      .max(1024)
      .regex(/^\S+@sha256:[a-f0-9]{64}$/),
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
    engineVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/),
    engineArtifactSha256: hash,
    profileSha256: hash,
    signatureManifestSha256: hash,
    signatureVerificationSha256: hash,
    signatureMaxAgeMs: z.number().int().min(1000).max(86400000),
    slots: z
      .array(z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/))
      .length(2)
      .refine((v) => new Set(v).size === 2),
  })
  .strict();
export function parseNasAntivirusClientPolicy(value: unknown): NasAntivirusClientPolicy {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('NAS antivirus policy unavailable');
  return parsed.data;
}
/** No service discovery, credentials, ambient ready flag or mutable runtime self-report is policy. */
export function loadNasAntivirusClientPolicy(options: {
  sha256: string;
  signatureMaxAgeMs: number;
}): NasAntivirusClientPolicy {
  try {
    const bytes = readAntivirusImmutableAsset({
      path: '/etc/cortex-document-antivirus/client-policy.json',
      sha256: options.sha256,
    });
    if (bytes.length > 65536) throw new Error('policy bound');
    const policy = parseNasAntivirusClientPolicy(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    if (policy.signatureMaxAgeMs !== options.signatureMaxAgeMs) throw new Error('policy mismatch');
    return Object.freeze(policy);
  } catch {
    throw new Error('NAS antivirus policy unavailable');
  }
}
