import { createHash } from 'node:crypto';
import {
  buildManagedRevision,
  canonicalManagedJson,
  managedDigest,
  verifyManagedRevision,
  validateManagedCapability,
  verifyManagedPurgeReceipt,
  validateManagedEvidence,
  managedIndexProfileSchema,
  managedRetrievalStateSchema,
} from './managed-retrieval';
import fixture from './__fixtures__/managed-retrieval-v1.json';
type FixtureCapability = Omit<typeof fixture.capability, 'allowedEntityIds'> & {
  allowedEntityIds: string[];
};
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

it('matches the cross-language canonical Unicode/escaping/safe-integer golden bytes', () => {
  for (const vector of fixture.canonicalVectors) {
    expect(canonicalManagedJson(vector.input)).toBe(vector.canonical);
    expect(managedDigest(vector.input, sha256)).toBe(vector.sha256);
  }
});
it.each([
  NaN,
  Infinity,
  -0,
  1.5,
  9007199254740992,
  '\ud800',
  '\udfff',
  new Date(),
  { bad_key: 1 },
  {
    get value() {
      throw new Error('must not execute getter');
    },
  },
  [undefined],
])('rejects noncanonical value %#', (value) => expect(() => canonicalManagedJson(value)).toThrow());
it('builds the immutable revision from original/extraction/approval evidence', () => {
  expect(buildManagedRevision(fixture.revisionInput as never, sha256)).toEqual(fixture.revision);
  expect(verifyManagedRevision(fixture.revision, sha256)).toEqual(fixture.revision);
  expect(managedDigest(managedIndexProfileSchema.parse(fixture.indexProfile), sha256)).toBe(
    fixture.key.indexGeneration,
  );
});
it('binds ownership, original, extractor and extraction policy while excluding mutable retention counters', () => {
  for (const change of [
    (v: typeof fixture.revision & { retentionRevision?: number }) => {
      v.owner.userId = 'other';
    },
    (v: typeof fixture.revision & { retentionRevision?: number }) => {
      v.source.transferGeneration++;
    },
    (v: typeof fixture.revision & { retentionRevision?: number }) => {
      v.extractionPolicySha256 = 'e'.repeat(64);
    },
    (v: typeof fixture.revision & { retentionRevision?: number }) => {
      v.retentionRevision = 3;
    },
  ]) {
    const value = copy(fixture.revision);
    change(value);
    expect(() => verifyManagedRevision(value, sha256)).toThrow();
  }
  const other = copy(fixture.revisionInput);
  other.owner.userId = 'other';
  expect(() => buildManagedRevision(other as never, sha256)).toThrow();
});
it('requires exact signed purpose/owner/key/request/route and bounded content expiry', () => {
  expect(validateManagedCapability(fixture.capability, fixture.capabilityContext as never)).toEqual(
    fixture.capability,
  );
  for (const change of [
    (v: FixtureCapability) => {
      v.allowedEntityIds = ['wider'];
    },
    (v: FixtureCapability) => {
      v.owner.tenantId = 'other';
    },
    (v: FixtureCapability) => {
      v.exp++;
    },
    (v: FixtureCapability) => {
      v.keys.push(v.keys[0]);
    },
    (v: FixtureCapability) => {
      v.routePolicySha256 = 'f'.repeat(64);
    },
    (v: FixtureCapability) => {
      v.purpose = 'purge';
    },
    (v: FixtureCapability) => {
      v.workDeadline++;
    },
  ]) {
    const value = copy(fixture.capability);
    change(value);
    expect(() => validateManagedCapability(value, fixture.capabilityContext as never)).toThrow();
  }
});
it('uses bounded original cleanup authority without extending expired content read permission', () => {
  const capability = { ...fixture.capability, purpose: 'purge', operationId: 'purge-a' };
  const context = {
    ...fixture.capabilityContext,
    purpose: 'purge',
    operationId: 'purge-a',
    sourceExpiresAt: fixture.capability.iat - 1,
    cleanupDeadline: fixture.capability.exp,
  };
  expect(validateManagedCapability(capability, context as never)).toEqual(capability);
  expect(() =>
    validateManagedCapability(capability, { ...context, cleanupDeadline: undefined } as never),
  ).toThrow();
  expect(() =>
    validateManagedCapability(fixture.capability, {
      ...fixture.capabilityContext,
      sourceExpiresAt: fixture.capability.iat - 1,
      cleanupDeadline: fixture.capability.exp,
    } as never),
  ).toThrow();
});
it('binds a self-field-excluding purge receipt; missing row, live writer or old epoch is never terminal', () => {
  expect(
    verifyManagedPurgeReceipt(fixture.purgeReceipt, fixture.obligation as never, 'purge-a', sha256),
  ).toEqual(fixture.purgeReceipt);
  for (const value of [
    null,
    { status: 404 },
    { ...fixture.purgeReceipt, activeWriters: 1 },
    { ...fixture.purgeReceipt, fenceEpoch: 1 },
    { ...fixture.purgeReceipt, backendIdentity: 'foreign' },
  ])
    expect(() =>
      verifyManagedPurgeReceipt(value, fixture.obligation as never, 'purge-a', sha256),
    ).toThrow();
  for (const extra of [{ purgeOperationId: 'other-purge' }, { receiptSha256: 'f'.repeat(64) }])
    expect(() =>
      verifyManagedPurgeReceipt(
        fixture.purgeReceipt,
        { ...fixture.obligation, ...extra } as never,
        'purge-a',
        sha256,
      ),
    ).toThrow();
  expect(fixture.admissionInvariant).toEqual({
    schedule: [
      'purge-before-source-row',
      'durable-full-key-tombstone-at-epoch-2',
      'late-first-admission-at-epoch-1',
    ],
    providerDispatchPermitted: false,
    missingRowIsTerminal: false,
  });
});
it('returns only exact admitted UTF-16 evidence and rejects split astral boundaries/foreign text', () => {
  expect(
    validateManagedEvidence(
      fixture.evidence,
      fixture.revision,
      fixture.revisionInput.document,
      sha256,
    ),
  ).toBe(fixture.revisionInput.document.text);
  const split = fixture.revisionInput.document.text.indexOf('😀') + 1;
  expect(() =>
    validateManagedEvidence(
      { ...fixture.evidence, start: split },
      fixture.revision,
      fixture.revisionInput.document,
      sha256,
    ),
  ).toThrow();
  expect(() =>
    validateManagedEvidence(
      fixture.evidence,
      fixture.revision,
      { ...fixture.revisionInput.document, text: 'foreign' },
      sha256,
    ),
  ).toThrow();
});
it('rejects duplicate/foreign obligations and a terminal state without receipt', () => {
  const state = {
    version: 1,
    revision: fixture.revision,
    inventory: 'unknown',
    obligations: [fixture.obligation],
  };
  expect(managedRetrievalStateSchema.safeParse(state).success).toBe(true);
  expect(
    managedRetrievalStateSchema.safeParse({
      ...state,
      obligations: [fixture.obligation, fixture.obligation],
    }).success,
  ).toBe(false);
  expect(
    managedRetrievalStateSchema.safeParse({
      ...state,
      obligations: [{ ...fixture.obligation, state: 'purged' }],
    }).success,
  ).toBe(false);
});
