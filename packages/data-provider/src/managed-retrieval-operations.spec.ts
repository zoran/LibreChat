/** Cross-language fixtures exercise the provider-owned wire contracts and complete validators. */
import { createHash } from 'node:crypto';
import {
  readManagedRetrievalRequest,
  validateManagedRetrievalLookup,
  verifyManagedIndexReceipt,
  verifyManagedQueryResult,
} from './managed-retrieval-operations';
import {
  canonicalManagedJson,
  managedDigest,
  verifyManagedPurgeReceipt,
} from './managed-retrieval';
import fixture from './__fixtures__/managed-retrieval-operations-v1.json';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const operations = fixture.operations;
type FixtureLookup = Omit<typeof operations.query.lookup, 'sources'> & {
  sources: Array<
    Omit<(typeof operations.query.lookup.sources)[number], 'currentExpiresAt'> & {
      currentExpiresAt: number | null;
    }
  >;
};
type FixtureQueryResult = Omit<typeof operations.query.result, 'hits'> & {
  hits: Array<(typeof operations.query.result.hits)[number] & { score?: number }>;
};
const verifyLookup = (value: unknown, purpose: keyof typeof operations = 'query') =>
  validateManagedRetrievalLookup(
    value,
    operations[purpose].selector as never,
    fixture.selection.content.backendIdentity,
    sha,
  );

it('keeps document Unicode whitespace identical to the existing document owner', () => {
  for (const [character, accepted] of [
    ['\ufeff', false],
    ['\u00a0', false],
    ['\u0085', true],
  ] as const) {
    const body = copy(operations.index.body);
    body.document.text = character.repeat(42);
    if (accepted) expect(readManagedRetrievalRequest('index', body)).toEqual(body);
    else expect(() => readManagedRetrievalRequest('index', body)).toThrow();
  }
});

it.each(['index', 'query', 'purge'] as const)(
  'serializes the existing File projection and %s body identically to Python',
  (purpose) => {
    const item = operations[purpose];
    expect(readManagedRetrievalRequest(purpose as never, item.body)).toEqual(item.body);
    expect(canonicalManagedJson(item.body)).toBe(item.canonicalBody);
    expect(sha(item.canonicalBody)).toBe(item.bodySha256);
    expect(verifyLookup(item.lookup, purpose)).toEqual(item.lookup);
  },
);

it('rejects alternate request shapes and bounds', () => {
  for (const [purpose, body] of [
    ['index', { ...operations.index.body, owner: operations.index.selector.owner }],
    ['query', { ...operations.query.body, profile: fixture.selection.indexProfile }],
    ['query', { ...operations.query.body, limit: 33 }],
    ['query', { ...operations.query.body, query: ' \r\n\t' }],
    [
      'query',
      {
        ...operations.query.body,
        keys: [operations.query.body.keys[0], operations.query.body.keys[0]],
      },
    ],
    ['purge', { ...operations.purge.body, operationId: 'new-op' }],
  ] as const)
    expect(() => readManagedRetrievalRequest(purpose as never, body)).toThrow();
});

it('rejects forged File authority, missing original binding and changed absolute clocks', () => {
  const changes = [
    (v: FixtureLookup) => {
      v.authority.requestSha256 = '0'.repeat(64);
    },
    (v: FixtureLookup) => {
      v.original.workDeadline += 1;
    },
    (v: FixtureLookup) => {
      v.original.technicalCleanupDeadline += 1;
    },
    (v: FixtureLookup) => {
      v.sources[0].indexOriginal.backendIdentity = 'other';
    },
    (v: FixtureLookup) => {
      v.sources[0].indexOriginal.writerEpoch += 1;
    },
    (v: FixtureLookup) => {
      v.sources[0].indexOriginal.state = 'purge_pending';
    },
    (v: FixtureLookup) => {
      v.sources[0].revision.owner.userId = 'other';
    },
    (v: FixtureLookup) => {
      v.sources[0].key.indexGeneration = '0'.repeat(64);
    },
    (v: FixtureLookup) => {
      v.sources[0].currentExpiresAt = null;
    },
    (v: FixtureLookup) => {
      v.sources.push(v.sources[0]);
    },
  ];
  for (const change of changes) {
    const value = copy(operations.query.lookup);
    change(value);
    expect(() => verifyLookup(value)).toThrow();
  }
  const shorter = copy(operations.query.lookup);
  shorter.sources[0].currentExpiresAt = fixture.now + 30;
  shorter.authority.sourceExpiresAt = fixture.now + 30;
  expect(verifyLookup(shorter)).toEqual(shorter);
  expect(shorter.original.workDeadline).toBe(operations.query.lookup.original.workDeadline);
});

it('validates current File retention independently of historical index expiry', () => {
  const value = copy(operations.query.lookup);
  for (const source of value.sources) source.originalExpiresAt = fixture.now - 1;
  value.authority.sourceExpiresAt = Math.min(
    ...value.sources.map((source) => source.currentExpiresAt!),
  );
  expect(verifyLookup(value)).toEqual(value);
  const stale = copy(value);
  stale.authority.sourceExpiresAt = fixture.now - 1;
  expect(() => verifyLookup(stale)).toThrow();
  const widened = copy(value);
  widened.authority.sourceExpiresAt! += 1;
  expect(() => verifyLookup(widened)).toThrow();
  expect(value.original).toEqual(operations.query.lookup.original);
});

it('binds ready receipt identity and completion to the original exclusive deadline', () => {
  const { result, binding } = operations.index;
  expect(verifyManagedIndexReceipt(result, binding, sha)).toEqual(result);
  for (const change of [
    (v: typeof operations.index.result) => {
      v.operationId = 'other';
    },
    (v: typeof operations.index.result) => {
      v.requestSha256 = '0'.repeat(64);
    },
    (v: typeof operations.index.result) => {
      v.backendIdentity = 'other';
    },
    (v: typeof operations.index.result) => {
      v.writerEpoch += 1;
    },
    (v: typeof operations.index.result) => {
      v.key = operations.query.body.keys[1];
    },
    (v: typeof operations.index.result) => {
      v.completedAt = binding.workDeadline;
    },
    (v: typeof operations.index.result) => {
      v.completedAt = binding.admittedAt - 1;
    },
  ]) {
    const value = copy(result);
    change(value);
    const { receiptSha256: _, ...payload } = value;
    value.receiptSha256 = managedDigest(payload, sha);
    expect(() => verifyManagedIndexReceipt(value, binding, sha)).toThrow();
  }
  expect(() =>
    verifyManagedIndexReceipt({ ...result, receiptSha256: '0'.repeat(64) }, binding, sha),
  ).toThrow();
});

it('releases only exact current citation spans under the original ordered source/ranking binding', () => {
  const { result, binding, trustedSources } = operations.query;
  const verify = (value: unknown) =>
    verifyManagedQueryResult(value, binding, trustedSources as never, sha);
  expect(verify(result)).toEqual(result);
  expect(verify({ ...result, hits: [] }).hits).toEqual([]);
  for (const change of [
    (v: FixtureQueryResult) => {
      v.keys.reverse();
    },
    (v: FixtureQueryResult) => {
      v.rankingPolicySha256 = '0'.repeat(64);
    },
    (v: FixtureQueryResult) => {
      v.hits[0].text += ' invented';
    },
    (v: FixtureQueryResult) => {
      v.hits[0].key = v.keys[1];
    },
    (v: FixtureQueryResult) => {
      v.hits[0].evidence.start += 1;
    },
    (v: FixtureQueryResult) => {
      v.hits.push(v.hits[0]);
    },
    (v: FixtureQueryResult) => {
      v.hits[0].score = 0.9;
    },
  ]) {
    const value = copy(result);
    change(value);
    expect(() => verify(value)).toThrow();
  }
  expect(() =>
    verifyManagedQueryResult(result, binding, [...trustedSources].reverse() as never, sha),
  ).toThrow();
});

it('retains the original purge wire and existing complete receipt validator', () => {
  const { result, body, binding } = operations.purge;
  expect(
    verifyManagedPurgeReceipt(result, binding as never, body.purgeOperationId, sha, body.keys),
  ).toEqual(result);
  for (const invalid of [{ status: 404 }, true, null, { ...result, activeWriters: 1 }])
    expect(() =>
      verifyManagedPurgeReceipt(invalid, binding as never, body.purgeOperationId, sha, body.keys),
    ).toThrow();
});
