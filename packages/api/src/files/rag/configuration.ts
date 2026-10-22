/** One inert deployment-file parser. Native delivery authenticates inputs; File retains receipt authority. */
import { z } from 'zod';
import { TextDecoder } from 'node:util';
import { createHash } from 'node:crypto';
import { parseFileRetrievalPolicySnapshot } from '@librechat/data-schemas';
import {
  canonicalManagedJson,
  managedDigest,
  managedIndexProfileSchema,
} from 'librechat-data-provider';
import type { TrustedManagedFileConfiguration } from './managed';

/** A control-plane format bound, independent of document/user resource quotas. */
export const MANAGED_FILE_DEPLOYMENT_MAX_BYTES = 65_536;

/** Supplied independently by the trusted deployment composition, never copied from the input file. */
export type ManagedFileDeploymentExpectations = Readonly<{
  sourceRevision: string;
  imageDigest: string;
  namespaceUid: string;
  configurationSha256: string;
}>;

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const targetSchema = z
  .object({
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    namespaceUid: z
      .string()
      .regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
      .refine((value) => value !== '00000000-0000-0000-0000-000000000000'),
  })
  .strict();
const expectationsSchema = targetSchema.extend({ configurationSha256: hash }).strict();
const envelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal('cortex-managed-file-retrieval'),
    target: targetSchema,
    trustedFile: z
      .object({
        extractionPolicySha256: hash,
        retrieval: z
          .object({
            profile: managedIndexProfileSchema,
            policySnapshot: z.unknown(),
            transport: z
              .object({
                backendIdentity: z.string().min(1).max(256),
                url: z.string().min(1).max(2048),
                serverCertificateSha256: hash,
              })
              .strict(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** Sanitized invariant failure shared by parsing and acquisition; never includes mounted contents. */
export function managedFileConfigurationUnavailable(): Error {
  return Object.assign(new Error('Managed retrieval configuration unavailable'), {
    code: 'managed_retrieval_configuration_unavailable',
  });
}

/** Capture before the first asynchronous acquisition boundary. */
export function snapshotManagedFileDeploymentExpectations(
  value: ManagedFileDeploymentExpectations,
): ManagedFileDeploymentExpectations {
  try {
    return Object.freeze(expectationsSchema.parse(value));
  } catch {
    throw managedFileConfigurationUnavailable();
  }
}

function freezeSnapshot(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) freezeSnapshot(child);
  Object.freeze(value);
}

/** Parse exact canonical bytes; no model, credential, client, health probe or receipt is acquired. */
export function parseManagedFileDeploymentConfiguration(
  bytes: Uint8Array,
  expected: ManagedFileDeploymentExpectations,
): TrustedManagedFileConfiguration {
  try {
    const target = snapshotManagedFileDeploymentExpectations(expected);
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength === 0 ||
      bytes.byteLength > MANAGED_FILE_DEPLOYMENT_MAX_BYTES ||
      sha256(bytes) !== target.configurationSha256
    )
      throw managedFileConfigurationUnavailable();
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const json: unknown = JSON.parse(text);
    if (text !== canonicalManagedJson(json) + '\n') throw managedFileConfigurationUnavailable();
    const envelope = envelopeSchema.parse(json);
    if (
      envelope.target.sourceRevision !== target.sourceRevision ||
      envelope.target.imageDigest !== target.imageDigest ||
      envelope.target.namespaceUid !== target.namespaceUid
    )
      throw managedFileConfigurationUnavailable();
    const supplied = envelope.trustedFile;
    const policy = parseFileRetrievalPolicySnapshot(supplied.retrieval.policySnapshot);
    const { profile, transport } = supplied.retrieval;
    const url = new URL(transport.url);
    const generation = managedDigest(profile, sha256);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== '/' && url.pathname !== '') ||
      policy.content.indexGeneration !== generation ||
      policy.content.backendIdentity !== transport.backendIdentity ||
      !policy.purge.some(
        (entry) => canonicalManagedJson(entry) === canonicalManagedJson(policy.content),
      )
    )
      throw managedFileConfigurationUnavailable();
    const trustedFile: TrustedManagedFileConfiguration = {
      extractionPolicySha256: supplied.extractionPolicySha256,
      retrieval: { profile, policySnapshot: policy, transport },
    };
    freezeSnapshot(trustedFile);
    return trustedFile;
  } catch {
    throw managedFileConfigurationUnavailable();
  }
}
