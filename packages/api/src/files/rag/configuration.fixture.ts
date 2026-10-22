/** Synthetic configuration inputs exercise parsing, never native admission or receipt authenticity. */
import { createHash } from 'node:crypto';
import { canonicalManagedJson } from 'librechat-data-provider';
import type { ManagedFileDeploymentExpectations } from './configuration';
import fixture from '../../../../data-provider/src/__fixtures__/managed-retrieval-v1.json';

export const configurationDigest = (value: Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
export const configurationBytes = (value: unknown) =>
  Buffer.from(canonicalManagedJson(value) + '\n');

export function deploymentInput() {
  const content = {
    backendIdentity: fixture.obligation.backendIdentity,
    routePolicySha256: '1'.repeat(64),
    rankingPolicySha256: '2'.repeat(64),
    indexGeneration: fixture.key.indexGeneration,
    writerEpoch: 7,
    provenanceSha256: '3'.repeat(64),
  };
  return {
    schemaVersion: 1,
    purpose: 'cortex-managed-file-retrieval',
    target: {
      sourceRevision: 'a'.repeat(40),
      imageDigest: 'sha256:' + 'b'.repeat(64),
      namespaceUid: '11111111-2222-4333-8444-555555555555',
    },
    trustedFile: {
      extractionPolicySha256: fixture.revision.extractionPolicySha256,
      retrieval: {
        profile: { ...fixture.indexProfile },
        policySnapshot: {
          version: 1,
          source: { provenanceSha256: content.provenanceSha256 },
          content,
          purge: [{ ...content }],
        },
        transport: {
          backendIdentity: content.backendIdentity,
          url: 'https://retrieval.invalid',
          serverCertificateSha256: '7'.repeat(64),
        },
      },
    },
  };
}

export function configurationFixture() {
  const input = deploymentInput();
  const bytes = configurationBytes(input);
  const expected: ManagedFileDeploymentExpectations = {
    ...input.target,
    configurationSha256: configurationDigest(bytes),
  };
  return { input, bytes, expected };
}
