import type {
  UploadDerivedIntent,
  UploadDerivedOrigin,
  UploadDerivedSource,
} from './upload-derived';
import {
  readUploadDerivedIntent,
  readUploadDerivedOrigin,
  readHistoricalUploadDerivedOrigin,
  sameUploadDerivedOrigin,
  uploadReservationFingerprint,
} from './upload-derived';

const binding = { purpose: 'workspace-draft' as const, sourceId: 'workspace-1', sourceRevision: 0 };
const now = Date.UTC(2026, 9, 17);
const source = (id: string): UploadDerivedSource => ({
  subject: {
    tenantId: 'tenant',
    userId: 'user',
    operationId: id,
    transferGeneration: 1,
    mediaType: 'text/plain',
    bytes: 10,
    sha256: 'a'.repeat(64),
  },
  policySha256: 'b'.repeat(64),
  sourceBindingSha256: 'c'.repeat(64),
  expiresAt: now + 1000,
});
const origin = (): UploadDerivedOrigin => ({
  version: 2,
  binding: { ...binding },
  directSourceFileIds: ['b', 'a'],
  ancestors: [source('b'), source('a')],
});

describe('private derived upload contract', () => {
  test('detaches every nested value and canonicalizes source order', () => {
    const input = origin();
    const captured = readUploadDerivedOrigin(input)!;
    expect(captured.directSourceFileIds).toEqual(['a', 'b']);
    expect(captured.ancestors.map((s) => s.subject.operationId)).toEqual(['a', 'b']);
    input.binding.sourceRevision++;
    input.ancestors[0].subject.sha256 = 'c'.repeat(64);
    input.ancestors[0].expiresAt++;
    input.directSourceFileIds[0] = 'changed';
    expect(captured.binding.sourceRevision).toBe(0);
    expect(captured.ancestors[1]).toEqual(source('b'));
    expect(captured.directSourceFileIds).toEqual(['a', 'b']);
  });

  test.each([
    [
      'newline in consumer identifier',
      (v: UploadDerivedOrigin) => {
        v.binding.sourceId = 'workspace-1\n';
      },
    ],
    [
      'newline in direct source identifier',
      (v: UploadDerivedOrigin) => {
        v.directSourceFileIds = ['a\n'];
      },
    ],
    [
      'newline in policy hash',
      (v: UploadDerivedOrigin) => {
        v.ancestors[0].policySha256 += '\n';
      },
    ],
    [
      'unknown origin field',
      (v: UploadDerivedOrigin) => {
        Object.assign(v, { approved: true });
      },
    ],
    [
      'extra binding field',
      (v: UploadDerivedOrigin) => {
        Object.assign(v.binding, { admin: true });
      },
    ],
    [
      'unknown consumer',
      (v: UploadDerivedOrigin) => {
        Object.assign(v.binding, { purpose: 'admin' });
      },
    ],
    [
      'unsafe revision',
      (v: UploadDerivedOrigin) => {
        v.binding.sourceRevision = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      'negative revision',
      (v: UploadDerivedOrigin) => {
        v.binding.sourceRevision = -1;
      },
    ],
    [
      'duplicate direct source',
      (v: UploadDerivedOrigin) => {
        v.directSourceFileIds = ['a', 'a'];
      },
    ],
    [
      'duplicate ancestor',
      (v: UploadDerivedOrigin) => {
        v.ancestors.push(source('a'));
      },
    ],
    [
      'missing direct source',
      (v: UploadDerivedOrigin) => {
        v.directSourceFileIds.push('missing');
      },
    ],
    [
      'empty direct scope with ancestors',
      (v: UploadDerivedOrigin) => {
        v.directSourceFileIds = [];
      },
    ],
    [
      'different owner',
      (v: UploadDerivedOrigin) => {
        v.ancestors[0].subject.userId = 'other';
      },
    ],
    [
      'different tenant',
      (v: UploadDerivedOrigin) => {
        v.ancestors[0].subject.tenantId = null;
      },
    ],
    [
      'different policy',
      (v: UploadDerivedOrigin) => {
        v.ancestors[0].policySha256 = 'c'.repeat(64);
      },
    ],
    [
      'invalid subject',
      (v: UploadDerivedOrigin) => {
        v.ancestors[0].subject.bytes = 0;
      },
    ],
    [
      'noncanonical hash',
      (v: UploadDerivedOrigin) => {
        v.ancestors[0].policySha256 = 'B'.repeat(64);
      },
    ],
    [
      'invalid date',
      (v: UploadDerivedOrigin) => {
        v.ancestors[0].expiresAt = 8_640_000_000_000_001;
      },
    ],
    [
      'array hole',
      (v: UploadDerivedOrigin) => {
        Reflect.deleteProperty(v.ancestors, '0');
      },
    ],
    [
      'array own extra',
      (v: UploadDerivedOrigin) => {
        Object.assign(v.ancestors, { extra: true });
      },
    ],
    [
      'foreign prototype',
      (v: UploadDerivedOrigin) => {
        Object.setPrototypeOf(v.binding, { privileged: true });
      },
    ],
    [
      'symbol field',
      (v: UploadDerivedOrigin) => {
        Object.defineProperty(v, Symbol('extra'), { value: true });
      },
    ],
    [
      'nonenumerable field',
      (v: UploadDerivedOrigin) => {
        Object.defineProperty(v, 'version', { enumerable: false });
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const input = origin();
    mutate(input);
    expect(readUploadDerivedOrigin(input)).toBeNull();
  });

  test('never invokes nested accessors, including array indexes', () => {
    const getter = jest.fn(() => source('b'));
    const input = origin();
    Object.defineProperty(input.ancestors, '0', { get: getter, enumerable: true });
    expect(readUploadDerivedOrigin(input)).toBeNull();
    const value = { binding, directSourceFileIds: ['a'] };
    Object.defineProperty(value, 'binding', { get: getter, enumerable: true });
    expect(readUploadDerivedIntent(value)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  test('rejects revoked proxies without throwing', () => {
    const { proxy, revoke } = Proxy.revocable(origin(), {});
    revoke();
    expect(readUploadDerivedOrigin(proxy)).toBeNull();
    expect(readUploadDerivedIntent(proxy)).toBeNull();
  });

  test('enforces count and serialized budget independently', () => {
    const ids = Array.from({ length: 65 }, (_, i) => `file-${i}`);
    expect(readUploadDerivedIntent({ binding, directSourceFileIds: ids })).toBeNull();
    const withinCount = ids.slice(0, 64);
    expect(
      readUploadDerivedOrigin({
        version: 2,
        binding,
        directSourceFileIds: withinCount,
        ancestors: withinCount.map(source),
      }),
    ).toBeNull();
  });

  test('preserves source-free intent and captured provenance while comparing immutable identities', () => {
    const empty: UploadDerivedOrigin = {
      version: 2,
      binding,
      directSourceFileIds: [],
      ancestors: [],
    };
    expect(readUploadDerivedOrigin(empty)).toEqual(empty);
    const captured = readUploadDerivedOrigin(origin())!;
    const current = readUploadDerivedOrigin(origin())!;
    current.ancestors[0].expiresAt += 7 * 86400000;
    expect(sameUploadDerivedOrigin(captured, current)).toBe(true);
    current.ancestors[0].sourceBindingSha256 = 'd'.repeat(64);
    expect(sameUploadDerivedOrigin(captured, current)).toBe(false);
  });

  test('admits historical origin solely for migration custody, never current authority', () => {
    const historical = {
      ...origin(),
      version: 1,
      ancestors: origin().ancestors.map(({ sourceBindingSha256: _binding, ...source }) => source),
    };
    expect(readUploadDerivedOrigin(historical)).toBeNull();
    expect(readHistoricalUploadDerivedOrigin(historical)?.version).toBe(1);
    const missingBinding = origin();
    delete (missingBinding.ancestors[0] as Partial<UploadDerivedSource>).sourceBindingSha256;
    expect(readUploadDerivedOrigin(missingBinding)).toBeNull();
    expect(readHistoricalUploadDerivedOrigin(missingBinding)).toBeNull();
  });

  test('preserves ordinary fingerprints and binds every derived intent field', () => {
    const request = {
      scope: { kind: 'personal' as const },
      mediaType: 'text/plain',
      declaredBytes: 10,
    };
    const intent: UploadDerivedIntent = { binding, directSourceFileIds: ['b', 'a'] };
    expect(uploadReservationFingerprint(request)).toBe(
      JSON.stringify([request.scope, 'text/plain', 10]),
    );
    const fingerprint = uploadReservationFingerprint(request, intent);
    expect(fingerprint).toBe(
      uploadReservationFingerprint(request, { ...intent, directSourceFileIds: ['a', 'b'] }),
    );
    expect(fingerprint).not.toBe(uploadReservationFingerprint(request));
    expect(fingerprint).not.toBe(
      uploadReservationFingerprint(request, {
        ...intent,
        binding: { ...binding, sourceRevision: 1 },
      }),
    );
    expect(fingerprint).not.toBe(
      uploadReservationFingerprint(request, {
        ...intent,
        binding: { ...binding, sourceId: 'workspace-2' },
      }),
    );
    expect(fingerprint).not.toBe(
      uploadReservationFingerprint(request, { ...intent, directSourceFileIds: ['a'] }),
    );
  });
});
