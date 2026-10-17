/** Exercises the private receipt boundary; a well-shaped receipt is never scanner authentication. */
import type { UploadSecuritySubject, UploadSecurityApproval } from './upload-security';
import {
  isUploadSecuritySubject,
  isUploadSecurityApproval,
  isUploadSecurityDecision,
  isUploadSecurityInspection,
  readUploadSecurityInspection,
  matchesUploadSecurityApproval,
} from './upload-security';
import { UPLOAD_MAX_FILE_BYTES } from './upload-management';

const policySha256 = 'a'.repeat(64);
const now = Date.parse('2026-10-17T02:00:00.000Z');
const subject = (): UploadSecuritySubject => ({
  tenantId: 'tenant-a',
  userId: 'user-1',
  operationId: 'operation-1',
  transferGeneration: 1,
  mediaType: 'text/plain',
  bytes: 8,
  sha256: 'b'.repeat(64),
});
const approval = (): UploadSecurityApproval => ({
  version: 1,
  decision: 'approved',
  policySha256,
  subject: subject(),
  scannerVersion: 'local-inspector/v1.2.3+build-4',
  checkedAt: new Date(now).toISOString(),
  coverage: { complete: true, pages: 1, parts: 1 },
});

function accessor(value: object, key: string, get: () => unknown): object {
  return Object.defineProperty({ ...value }, key, { enumerable: true, get });
}

describe('upload security subject', () => {
  it('accepts exact bounded bytes and explicit null tenant without mutating input', () => {
    for (const bytes of [1, UPLOAD_MAX_FILE_BYTES]) {
      const value = Object.freeze({ ...subject(), tenantId: null, bytes });
      expect(isUploadSecuritySubject(value)).toBe(true);
      expect(value).toEqual({ ...subject(), tenantId: null, bytes });
    }
    expect(isUploadSecuritySubject(Object.assign(Object.create(null), subject()))).toBe(true);
  });

  it.each([0, -1, 0.5, NaN, Infinity, -Infinity, UPLOAD_MAX_FILE_BYTES + 1, '8'])(
    'rejects invalid or excessive bytes %s',
    (bytes) => expect(isUploadSecuritySubject({ ...subject(), bytes })).toBe(false),
  );

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'])(
    'rejects invalid transfer generation %s',
    (transferGeneration) =>
      expect(isUploadSecuritySubject({ ...subject(), transferGeneration })).toBe(false),
  );

  it.each([
    ['missing tenant', { tenantId: undefined }],
    ['empty tenant', { tenantId: '' }],
    ['system tenant', { tenantId: '__SYSTEM__' }],
    ['tenant query', { tenantId: { $ne: null } }],
    ['tenant path', { tenantId: '../tenant' }],
    ['empty user', { userId: '' }],
    ['oversized user', { userId: 'u'.repeat(129) }],
    ['user newline', { userId: 'user\n' }],
    ['unicode user', { userId: 'usér' }],
    ['operation path', { operationId: '/operation' }],
    ['operation control', { operationId: 'operation\u0000' }],
    ['uppercase MIME', { mediaType: 'Text/Plain' }],
    ['MIME parameters', { mediaType: 'text/plain; charset=utf-8' }],
    ['MIME wildcard', { mediaType: 'text/*' }],
    ['MIME trailing newline', { mediaType: 'text/plain\n' }],
    ['oversized MIME', { mediaType: 'text/' + 'a'.repeat(123) }],
    ['uppercase digest', { sha256: 'B'.repeat(64) }],
    ['short digest', { sha256: 'b'.repeat(63) }],
    ['nonhex digest', { sha256: 'g'.repeat(64) }],
    ['digest newline', { sha256: 'b'.repeat(63) + '\n' }],
  ])('rejects %s', (_name, change) => {
    expect(isUploadSecuritySubject({ ...subject(), ...change })).toBe(false);
  });

  it('requires every field and rejects unknown, hidden and symbol fields', () => {
    for (const key of Object.keys(subject())) {
      const value: Record<string, unknown> = { ...subject() };
      delete value[key];
      expect(isUploadSecuritySubject(value)).toBe(false);
    }
    expect(isUploadSecuritySubject({ ...subject(), filename: 'private.txt' })).toBe(false);
    expect(isUploadSecuritySubject({ ...subject(), extra: undefined })).toBe(false);
    expect(isUploadSecuritySubject({ ...subject(), [Symbol('extra')]: true })).toBe(false);
    expect(
      isUploadSecuritySubject(Object.defineProperty(subject(), 'userId', { enumerable: false })),
    ).toBe(false);
    expect(
      isUploadSecuritySubject(Object.defineProperty(subject(), 'extra', { value: true })),
    ).toBe(false);
  });
});

describe('closed upload security approval', () => {
  it('accepts complete bounded coverage, canonical UTC time and frozen/null-prototype records', () => {
    const value = Object.freeze({
      ...approval(),
      subject: Object.freeze(Object.assign(Object.create(null), subject())),
      coverage: Object.freeze({ complete: true, pages: 500, parts: 2048 }),
    });
    expect(isUploadSecurityApproval(value)).toBe(true);
    expect(isUploadSecurityApproval(Object.assign(Object.create(null), value))).toBe(true);
    expect(matchesUploadSecurityApproval(value, subject(), policySha256, now)).toBe(true);
  });

  it.each([
    ['future contract', { version: 2 }],
    ['string contract', { version: '1' }],
    ['rejection', { decision: 'rejected' }],
    ['unknown decision', { decision: 'unknown' }],
    ['uppercase policy', { policySha256: 'A'.repeat(64) }],
    ['short policy', { policySha256: 'a'.repeat(63) }],
    ['unknown filename', { filename: 'secret' }],
    ['empty scanner', { scannerVersion: '' }],
    ['scanner whitespace', { scannerVersion: 'inspector v1' }],
    ['scanner control', { scannerVersion: 'inspector\n' }],
    ['oversized scanner', { scannerVersion: 's'.repeat(129) }],
    ['missing coverage', { coverage: undefined }],
    ['incomplete coverage', { coverage: { complete: false, pages: 1, parts: 1 } }],
    ['empty pages', { coverage: { complete: true, pages: 0, parts: 1 } }],
    ['excess pages', { coverage: { complete: true, pages: 501, parts: 1 } }],
    ['excess parts', { coverage: { complete: true, pages: 1, parts: 2049 } }],
    ['nonfinite parts', { coverage: { complete: true, pages: 1, parts: Infinity } }],
    ['fractional pages', { coverage: { complete: true, pages: 0.5, parts: 1 } }],
    ['extra coverage field', { coverage: { complete: true, pages: 1, parts: 1, text: 'private' } }],
    ['incomplete subject', { subject: { userId: 'user-1' } }],
  ])('rejects %s', (_name, change) => {
    expect(isUploadSecurityApproval({ ...approval(), ...change })).toBe(false);
  });

  it.each([
    undefined,
    now,
    '',
    '2026-10-17T02:00:00Z',
    '2026-10-17T02:00:00.000+00:00',
    '2026-10-17T03:00:00.000+01:00',
    '2026-02-30T02:00:00.000Z',
    '2026-10-17T24:00:00.000Z',
    '2026-10-17T02:00:60.000Z',
    '2026-10-17T02:00:00.000Z\n',
    '+010000-10-17T02:00:00.000Z',
  ])('rejects noncanonical or invalid check time %s', (checkedAt) => {
    expect(isUploadSecurityApproval({ ...approval(), checkedAt })).toBe(false);
  });

  it('requires every receipt field and rejects all negative decisions as approvals', () => {
    for (const key of Object.keys(approval())) {
      const value: Record<string, unknown> = { ...approval() };
      delete value[key];
      expect(isUploadSecurityApproval(value)).toBe(false);
    }
    for (const decision of ['rejected', 'uninspectable']) {
      expect(
        isUploadSecurityApproval({ version: 1, decision, reason: 'scanner_unavailable' }),
      ).toBe(false);
    }
  });
});

describe('untrusted records cannot run accessors or inherit proof', () => {
  it.each([undefined, null, true, 1, 'approved', [], new Date(), new Map()])(
    'refuses nonrecord %s without throwing',
    (value) => {
      expect(isUploadSecuritySubject(value)).toBe(false);
      expect(isUploadSecurityApproval(value)).toBe(false);
      expect(matchesUploadSecurityApproval(value, subject(), policySha256, now)).toBe(false);
    },
  );

  it('rejects custom prototypes at every nested boundary', () => {
    const inherited = Object.create(subject());
    const custom = Object.assign(Object.create({ authenticated: true }), subject());
    expect(isUploadSecuritySubject(inherited)).toBe(false);
    expect(isUploadSecuritySubject(custom)).toBe(false);
    expect(isUploadSecurityApproval(Object.create(approval()))).toBe(false);
    expect(isUploadSecurityApproval({ ...approval(), subject: custom })).toBe(false);
    expect(
      isUploadSecurityApproval({ ...approval(), coverage: Object.create(approval().coverage) }),
    ).toBe(false);
  });

  it('rejects accessors, including on expected input, without invoking them', () => {
    const get = jest.fn(() => {
      throw new Error('Do not evaluate untrusted content');
    });
    const badSubject = accessor(subject(), 'sha256', get);
    const values = [
      accessor(approval(), 'decision', get),
      accessor(approval(), 'subject', get),
      { ...approval(), subject: badSubject },
      { ...approval(), coverage: accessor(approval().coverage, 'complete', get) },
      Object.defineProperty(approval(), 'checkedAt', { set: jest.fn() }),
    ];
    expect(isUploadSecuritySubject(badSubject)).toBe(false);
    for (const value of values) {
      expect(isUploadSecurityApproval(value)).toBe(false);
      expect(matchesUploadSecurityApproval(value, subject(), policySha256, now)).toBe(false);
    }
    expect(
      matchesUploadSecurityApproval(
        approval(),
        badSubject as UploadSecuritySubject,
        policySha256,
        now,
      ),
    ).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  it('treats revoked or throwing reflection as invalid data without propagating exceptions', () => {
    const revoked = Proxy.revocable(approval(), {});
    revoked.revoke();
    const failure = () => {
      throw new Error('Untrusted reflection failure');
    };
    for (const value of [
      revoked.proxy,
      new Proxy(approval(), { getPrototypeOf: failure }),
      new Proxy(approval(), { ownKeys: failure }),
      new Proxy(approval(), { getOwnPropertyDescriptor: failure }),
    ]) {
      expect(isUploadSecurityApproval(value)).toBe(false);
      expect(matchesUploadSecurityApproval(value, subject(), policySha256, now)).toBe(false);
    }
  });
});

describe('approval binding to the actual received original and current policy', () => {
  it('matches without mutating data and uses the supplied clock instead of wall time', () => {
    const value = approval();
    const before = JSON.stringify(value);
    expect(matchesUploadSecurityApproval(value, subject(), policySha256, now)).toBe(true);
    expect(matchesUploadSecurityApproval(value, subject(), policySha256, now + 1)).toBe(true);
    expect(matchesUploadSecurityApproval(value, subject(), policySha256, now - 1)).toBe(false);
    expect(isUploadSecurityApproval(value)).toBe(true);
    expect(JSON.stringify(value)).toBe(before);
  });

  it.each([
    { tenantId: null },
    { tenantId: 'tenant-b' },
    { userId: 'user-2' },
    { operationId: 'operation-2' },
    { transferGeneration: 2 },
    { mediaType: 'text/csv' },
    { bytes: 9 },
    { sha256: 'c'.repeat(64) },
  ])('refuses replay against a changed original binding %j', (change) => {
    expect(
      matchesUploadSecurityApproval(approval(), { ...subject(), ...change }, policySha256, now),
    ).toBe(false);
    expect(
      matchesUploadSecurityApproval(
        { ...approval(), subject: { ...subject(), ...change } },
        subject(),
        policySha256,
        now,
      ),
    ).toBe(false);
  });

  it.each(['c'.repeat(64), '', 'A'.repeat(64), 'a'.repeat(63) + '\n'])(
    'refuses stale or malformed expected policy %s',
    (policy) =>
      expect(matchesUploadSecurityApproval(approval(), subject(), policy, now)).toBe(false),
  );

  it.each([NaN, Infinity, -Infinity, -1, now + 0.5, Number.MAX_SAFE_INTEGER])(
    'refuses invalid caller clock %s',
    (time) =>
      expect(matchesUploadSecurityApproval(approval(), subject(), policySha256, time)).toBe(false),
  );

  it('validates expected data and never treats a digest or shape as authenticity', () => {
    expect(
      matchesUploadSecurityApproval(
        approval(),
        { ...subject(), extra: true } as UploadSecuritySubject,
        policySha256,
        now,
      ),
    ).toBe(false);
    const forged = JSON.parse(JSON.stringify(approval()));
    // Identical plain data cannot prove its issuer; trusted composition must mint/persist it.
    expect(matchesUploadSecurityApproval(forged, subject(), policySha256, now)).toBe(true);
  });
});

describe('closed scanner decision and explicit cleanup inspection', () => {
  const rejected = () => ({ version: 1, decision: 'rejected', reason: 'classification_marking' });
  const inspection = (decision: unknown = approval()) => ({
    decision,
    cleanup: { writerStopped: true, transientDataRemoved: true },
  });

  it.each([
    'classification_marking',
    'incomplete_coverage',
    'unsupported_format',
    'encrypted',
    'active_content',
    'invalid_content',
    'resource_limit',
    'scanner_unavailable',
    'ambiguous_marking',
  ])('accepts an explicit uninspectable decision for %s with confirmed cleanup', (reason) => {
    const decision = { version: 1, decision: 'uninspectable', reason };
    expect(isUploadSecurityDecision(decision)).toBe(true);
    expect(isUploadSecurityInspection(inspection(decision))).toBe(true);
  });

  it('accepts only the declared approved and classified-rejection shapes', () => {
    for (const decision of [approval(), rejected()]) {
      expect(isUploadSecurityDecision(decision)).toBe(true);
      expect(isUploadSecurityInspection(inspection(decision))).toBe(true);
    }
    const value = Object.freeze(
      Object.assign(Object.create(null), {
        decision: Object.freeze(Object.assign(Object.create(null), rejected())),
        cleanup: Object.freeze(Object.assign(Object.create(null), inspection().cleanup)),
      }),
    );
    expect(isUploadSecurityInspection(value)).toBe(true);
    expect(readUploadSecurityInspection(value)).toEqual(inspection(rejected()));
  });

  it.each([
    ['missing version', { decision: 'rejected', reason: 'classification_marking' }],
    ['future version', { version: 2, decision: 'rejected', reason: 'classification_marking' }],
    ['string version', { version: '1', decision: 'rejected', reason: 'classification_marking' }],
    ['missing reason', { version: 1, decision: 'rejected' }],
    ['active-content rejection', { version: 1, decision: 'rejected', reason: 'active_content' }],
    ['unsupported rejection', { version: 1, decision: 'rejected', reason: 'unsupported_format' }],
    ['unknown rejection', { version: 1, decision: 'rejected', reason: 'unexpected' }],
    [
      'unknown uninspectable reason',
      { version: 1, decision: 'uninspectable', reason: 'unexpected' },
    ],
    [
      'future uninspectable version',
      { version: 2, decision: 'uninspectable', reason: 'encrypted' },
    ],
    ['unknown decision', { version: 1, decision: 'unknown', reason: 'encrypted' }],
    ['extra content', { ...rejected(), content: 'private' }],
    ['invalid approval', { ...approval(), coverage: { complete: false, pages: 1, parts: 1 } }],
  ])('refuses %s even when cleanup is claimed', (_name, decision) => {
    expect(isUploadSecurityDecision(decision)).toBe(false);
    expect(isUploadSecurityInspection(inspection(decision))).toBe(false);
    expect(readUploadSecurityInspection(inspection(decision))).toBeNull();
  });

  it.each([
    ['missing cleanup', { decision: rejected() }],
    ['missing decision', { cleanup: inspection().cleanup }],
    ['bare legacy decision', rejected()],
    ['bare legacy approval', approval()],
    ['null cleanup', { ...inspection(), cleanup: null }],
    [
      'missing writer acknowledgement',
      { ...inspection(), cleanup: { transientDataRemoved: true } },
    ],
    ['missing removal acknowledgement', { ...inspection(), cleanup: { writerStopped: true } }],
    [
      'writer not stopped',
      { ...inspection(), cleanup: { writerStopped: false, transientDataRemoved: true } },
    ],
    [
      'transient copies remain',
      { ...inspection(), cleanup: { writerStopped: true, transientDataRemoved: false } },
    ],
    [
      'truthy cleanup strings',
      { ...inspection(), cleanup: { writerStopped: 'true', transientDataRemoved: 'true' } },
    ],
    [
      'extra cleanup field',
      { ...inspection(), cleanup: { ...inspection().cleanup, detail: 'private' } },
    ],
    ['extra envelope field', { ...inspection(), version: 1 }],
  ])('refuses %s rather than infer cleanup from settlement', (_name, value) => {
    expect(isUploadSecurityInspection(value)).toBe(false);
    expect(readUploadSecurityInspection(value)).toBeNull();
  });

  it('rejects inherited, hidden, symbol and accessor fields at each new boundary', () => {
    const get = jest.fn(() => {
      throw new Error('Untrusted getter must not run');
    });
    for (const [record, validate] of [
      [rejected(), isUploadSecurityDecision],
      [inspection(), isUploadSecurityInspection],
      [
        inspection().cleanup,
        (cleanup: unknown) => isUploadSecurityInspection({ ...inspection(), cleanup }),
      ],
    ] as const) {
      expect(validate(Object.create(record))).toBe(false);
      expect(validate(Object.assign(Object.create({ inherited: true }), record))).toBe(false);
      expect(validate({ ...record, [Symbol('extra')]: true })).toBe(false);
      expect(validate(Object.defineProperty({ ...record }, 'extra', { value: true }))).toBe(false);
      for (const key of Object.keys(record)) {
        expect(validate(Object.defineProperty({ ...record }, key, { enumerable: false }))).toBe(
          false,
        );
        expect(validate(accessor(record, key, get))).toBe(false);
        const missing: Record<string, unknown> = { ...record };
        delete missing[key];
        expect(validate(missing)).toBe(false);
      }
    }
    expect(isUploadSecurityInspection(inspection(accessor(rejected(), 'reason', get)))).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  it('returns a detached validated snapshot without ordinary reads on supplied records', () => {
    const decision = approval();
    const value = inspection(decision);
    const get = jest.fn(() => {
      throw new Error('Do not read supplied properties');
    });
    const snapshot = readUploadSecurityInspection(
      new Proxy(
        {
          decision: new Proxy(decision, { get }),
          cleanup: new Proxy(value.cleanup, { get }),
        },
        { get },
      ),
    );
    expect(snapshot).toEqual(value);
    expect(snapshot).not.toBe(value);
    expect(snapshot?.decision).not.toBe(decision);
    decision.subject.sha256 = 'c'.repeat(64);
    decision.coverage.pages = 0;
    value.cleanup.transientDataRemoved = false;
    expect(snapshot).toEqual(inspection(approval()));
    expect(get).not.toHaveBeenCalled();
  });

  it('fails closed for nonrecords and revoked or throwing reflective proxies', () => {
    const revoked = Proxy.revocable(inspection(), {});
    revoked.revoke();
    const fail = () => {
      throw new Error('Remote reflection failed');
    };
    for (const value of [
      undefined,
      null,
      false,
      1,
      'approved',
      [],
      new Date(),
      revoked.proxy,
      new Proxy(inspection(), { getPrototypeOf: fail }),
      new Proxy(inspection(), { ownKeys: fail }),
      new Proxy(inspection(), { getOwnPropertyDescriptor: fail }),
      inspection(new Proxy(rejected(), { ownKeys: fail })),
      {
        ...inspection(),
        cleanup: new Proxy(inspection().cleanup, { getOwnPropertyDescriptor: fail }),
      },
    ]) {
      expect(isUploadSecurityInspection(value)).toBe(false);
      expect(readUploadSecurityInspection(value)).toBeNull();
    }
    for (const value of [undefined, null, false, 1, [], new Date(), revoked.proxy])
      expect(isUploadSecurityDecision(value)).toBe(false);
  });
});
