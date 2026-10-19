/** Exercises the private receipt boundary; a well-shaped receipt is never scanner authentication. */
import type {
  UploadSecuritySubject,
  UploadSecurityApproval,
  UploadSecurityExecution,
  UploadSecuritySettlement,
} from './upload-security';
import {
  isUploadSecuritySubject,
  isUploadSecurityApproval,
  isUploadSecurityDecision,
  isUploadSecurityInspection,
  readUploadSecurityInspection,
  matchesUploadSecurityApproval,
  readUploadSecuritySubject,
  readUploadSecurityExecution,
  readUploadSecuritySettlement,
  matchesUploadSecurityExecution,
  isCompleteUploadSecuritySettlement,
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

const execution = (): UploadSecurityExecution => ({
  version: 2,
  custody: { kind: 'none' as const },
  attemptId: 'operation-1.1',
  instanceId: '12345678-9abc-4def-8123-456789abcdef',
  executionId: 'abcdef01-2345-4678-9abc-def012345678',
  expiresAt: '2026-10-17T03:00:00.000Z',
});
const settlement = (): UploadSecuritySettlement => ({
  execution: execution(),
  writerStopped: true,
  transientDataRemoved: true,
});

describe('scanner execution contract', () => {
  const pdfExecution = () => ({
    ...execution(),
    custody: {
      kind: 'pdf-ocr' as const,
      scope: {
        version: 1 as const,
        scopeId: 'original-document-scope',
        attemptId: execution().attemptId,
        scannerInstanceId: execution().instanceId,
        scannerExecutionId: execution().executionId,
        expiresAt: execution().expiresAt,
        providerBinding: {
          podUid: 'original-pod',
          containerId: 'c'.repeat(64),
          apiIncarnation: 'original-api',
          engineIncarnation: 'original-engine',
          workerIncarnation: 'original-worker',
          runtimeImage: `registry.invalid/ocr@sha256:${'a'.repeat(64)}`,
          sourceManifestSha256: 'b'.repeat(64),
          modelRevision: 'd'.repeat(40),
          profileSha256: 'e'.repeat(64),
        },
        documentSha256: subject().sha256,
        pageLimit: 32 as const,
        requestIdScheme: 'cortex-ocr-page-sha256-v1' as const,
        workDeadline: now / 1000 + 30,
        cleanupDeadline: now / 1000 + 31,
      },
    },
  });

  it('detaches and freezes the entire original PDF scope before an awaited consumer', async () => {
    const supplied = pdfExecution();
    const snapshot = readUploadSecurityExecution(supplied)!;
    expect(snapshot).toEqual(supplied);
    await Promise.resolve();
    supplied.custody.scope.providerBinding.engineIncarnation = 'replacement-engine';
    supplied.custody.scope.workDeadline++;
    expect(snapshot).toEqual(pdfExecution());
    expect(matchesUploadSecurityExecution(snapshot, supplied)).toBe(false);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.custody)).toBe(true);
    if (snapshot.custody.kind !== 'pdf-ocr') throw new Error('Missing PDF custody');
    expect(Object.isFrozen(snapshot.custody.scope)).toBe(true);
    expect(Object.isFrozen(snapshot.custody.scope.providerBinding)).toBe(true);
  });

  it('rejects missing or forged nested custody without evaluating accessors', () => {
    const get = jest.fn(() => {
      throw new Error('Untrusted getter');
    });
    const original = pdfExecution();
    for (const custody of [
      { kind: 'none', scope: original.custody.scope },
      { kind: 'pdf-ocr' },
      { ...original.custody, scope: accessor(original.custody.scope, 'scopeId', get) },
      {
        ...original.custody,
        scope: {
          ...original.custody.scope,
          providerBinding: accessor(
            original.custody.scope.providerBinding,
            'engineIncarnation',
            get,
          ),
        },
      },
      Object.create(original.custody),
    ])
      expect(readUploadSecurityExecution({ ...original, custody })).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    { pageLimit: 33 },
    { requestIdScheme: 'unknown-v2' },
    { workDeadline: now / 1000 + 32 },
    { cleanupDeadline: now / 1000 + 31.001 },
    { workDeadline: 0 },
    { workDeadline: NaN },
    { documentSha256: 'missing-original' },
  ])('rejects a changed original PDF bound %j', (change) => {
    const value = pdfExecution();
    expect(
      readUploadSecurityExecution({
        ...value,
        custody: { ...value.custody, scope: { ...value.custody.scope, ...change } },
      }),
    ).toBeNull();
  });

  it('does not treat two local cleanup booleans as PDF provider retirement', () => {
    const original = pdfExecution();
    expect(
      isCompleteUploadSecuritySettlement(
        {
          execution: original,
          writerStopped: true,
          transientDataRemoved: true,
        },
        original,
      ),
    ).toBe(false);
  });

  it('requires the full original document retirement, not an engine-only receipt', () => {
    const original = pdfExecution();
    const providerReceipt = {
      version: 1 as const,
      scope: original.custody.scope,
      state: 'retired' as const,
      writerStopped: true,
      transientDataRemoved: true,
      dispatchedPages: [1, 2],
    };
    const proof = {
      execution: original,
      writerStopped: true,
      transientDataRemoved: true,
      providerReceipt,
    };
    expect(isCompleteUploadSecuritySettlement(proof, original)).toBe(true);
    for (const receipt of [
      null,
      { ...providerReceipt, state: 'unknown' },
      { ...providerReceipt, transientDataRemoved: false },
      { ...providerReceipt, dispatchedPages: [1, 3] },
      { ...providerReceipt, engine_retired: true },
      { ...providerReceipt, scope: { ...providerReceipt.scope, scopeId: 'replacement' } },
    ]) {
      expect(
        isCompleteUploadSecuritySettlement({ ...proof, providerReceipt: receipt }, original),
      ).toBe(false);
    }
    expect(readUploadSecuritySettlement({ ...settlement(), providerReceipt })).toBeNull();
  });

  it('returns detached plain records from frozen or null-prototype input without a clock policy', () => {
    for (const attemptId of ['a.1', `${'a'.repeat(128)}.999999999999999`]) {
      const input = Object.freeze(Object.assign(Object.create(null), execution(), { attemptId }));
      const result = readUploadSecurityExecution(input)!;
      expect(result).toEqual(input);
      expect(result).not.toBe(input);
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    }
    expect(
      readUploadSecurityExecution({ ...execution(), expiresAt: '1970-01-01T00:00:00.000Z' }),
    ).not.toBeNull();
  });

  it.each([
    ['legacy version', { version: 1 }],
    ['future version', { version: 3 }],
    ['coerced version', { version: '1' }],
    ['empty attempt', { attemptId: '' }],
    ['missing generation', { attemptId: 'operation-1' }],
    ['zero generation', { attemptId: 'op.0' }],
    ['leading zero', { attemptId: 'op.01' }],
    ['fractional generation', { attemptId: 'op.1.5' }],
    ['oversized generation', { attemptId: 'op.1000000000000000' }],
    ['oversized operation', { attemptId: `${'a'.repeat(129)}.1` }],
    ['path attempt', { attemptId: '../op.1' }],
    ['newline attempt', { attemptId: 'op.1\n' }],
    ['control attempt', { attemptId: 'op.1\u0000' }],
    ['uppercase UUID', { instanceId: execution().instanceId.toUpperCase() }],
    ['wrong UUID version', { instanceId: '12345678-9abc-1def-8123-456789abcdef' }],
    ['wrong UUID variant', { executionId: 'abcdef01-2345-4678-0abc-def012345678' }],
    ['UUID suffix', { executionId: `${execution().executionId}\n` }],
    ['null UUID', { instanceId: null }],
    ['nonfinite UUID', { executionId: Infinity }],
    ['private filename', { filename: 'private.txt' }],
    ['private hash', { sha256: 'b'.repeat(64) }],
  ])('rejects %s', (_name, change) => {
    const value = { ...execution(), ...change };
    expect(readUploadSecurityExecution(value)).toBeNull();
    expect(matchesUploadSecurityExecution(value, execution())).toBe(false);
    expect(matchesUploadSecurityExecution(execution(), value)).toBe(false);
  });

  it.each([
    undefined,
    NaN,
    new Date(now),
    '2026-02-30T03:00:00.000Z',
    '2026-10-17T24:00:00.000Z',
    '2026-10-17T03:00:60.000Z',
    '2026-10-17T03:00:00Z',
    '2026-10-17T03:00:00.000+00:00',
    '2026-10-17T03:00:00.000Z\n',
    '+010000-10-17T03:00:00.000Z',
  ])('rejects noncanonical expiry %s', (expiresAt) => {
    expect(readUploadSecurityExecution({ ...execution(), expiresAt })).toBeNull();
  });

  it('requires every own enumerable field and rejects symbols and inherited records', () => {
    for (const key of Object.keys(execution())) {
      const value: Record<string, unknown> = { ...execution() };
      delete value[key];
      expect(readUploadSecurityExecution(value)).toBeNull();
      expect(
        readUploadSecurityExecution(Object.defineProperty(execution(), key, { enumerable: false })),
      ).toBeNull();
    }
    for (const value of [
      null,
      undefined,
      [],
      true,
      'execution',
      Object.create(execution()),
      Object.setPrototypeOf(execution(), { extra: true }),
      { ...execution(), [Symbol('hidden')]: true },
      Object.defineProperty(execution(), 'extra', { value: true }),
    ]) {
      expect(readUploadSecurityExecution(value)).toBeNull();
      expect(matchesUploadSecurityExecution(value, value)).toBe(false);
    }
  });

  it('rejects accessors and failed reflection on either side without evaluating them', () => {
    const get = jest.fn(() => {
      throw new Error('Untrusted getter');
    });
    const reflectionFailure = () => {
      throw new Error('Untrusted reflection');
    };
    const revoked = Proxy.revocable(execution(), {});
    revoked.revoke();
    for (const value of [
      ...Object.keys(execution()).map((key) => accessor(execution(), key, get)),
      Object.defineProperty(execution(), 'attemptId', { set: get }),
      revoked.proxy,
      new Proxy(execution(), { getPrototypeOf: reflectionFailure }),
      new Proxy(execution(), { ownKeys: reflectionFailure }),
      new Proxy(execution(), { getOwnPropertyDescriptor: reflectionFailure }),
    ]) {
      expect(readUploadSecurityExecution(value)).toBeNull();
      expect(matchesUploadSecurityExecution(value, execution())).toBe(false);
      expect(matchesUploadSecurityExecution(execution(), value)).toBe(false);
    }
    expect(get).not.toHaveBeenCalled();
  });

  it('binds every identity field and never uses ordinary property access on supplied records', () => {
    const get = jest.fn(() => {
      throw new Error('Do not reread data');
    });
    const value = new Proxy(execution(), { get });
    expect(readUploadSecurityExecution(value)).toEqual(execution());
    expect(matchesUploadSecurityExecution(value, execution())).toBe(true);
    for (const change of [
      { version: 1 },
      { attemptId: 'operation-1.2' },
      { attemptId: 'operation-2.1' },
      { instanceId: execution().executionId },
      { executionId: execution().instanceId },
      { expiresAt: '2026-10-17T03:00:00.001Z' },
    ]) {
      expect(matchesUploadSecurityExecution(value, { ...execution(), ...change })).toBe(false);
    }
    expect(get).not.toHaveBeenCalled();
  });

  it('exports the existing subject reader as a detached descriptor-based snapshot', () => {
    const input = subject();
    const get = jest.fn(() => {
      throw new Error('Do not reread subject');
    });
    const result = readUploadSecuritySubject(new Proxy(input, { get }));
    expect(result).toEqual(subject());
    expect(result).not.toBe(input);
    input.sha256 = 'c'.repeat(64);
    expect(result).toEqual(subject());
    expect(readUploadSecuritySubject(accessor(input, 'sha256', get))).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('scanner settlement contract', () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    'retains explicit stop=%s/removal=%s without inferring completion',
    (writerStopped, transientDataRemoved) => {
      const value = { ...settlement(), writerStopped, transientDataRemoved };
      expect(readUploadSecuritySettlement(value)).toEqual(value);
      expect(isCompleteUploadSecuritySettlement(value, execution())).toBe(
        writerStopped && transientDataRemoved,
      );
    },
  );

  it('snapshots nested execution and refuses a mismatched expected receipt', () => {
    const input = settlement();
    const result = readUploadSecuritySettlement(input)!;
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(result.execution).not.toBe(input.execution);
    input.writerStopped = false;
    input.execution.attemptId = 'operation-1.2';
    expect(result).toEqual(settlement());
    expect(isCompleteUploadSecuritySettlement(result, input.execution)).toBe(false);
    expect(isCompleteUploadSecuritySettlement(result, { ...execution(), extra: true })).toBe(false);
    expect(isCompleteUploadSecuritySettlement(result, null)).toBe(false);
  });

  it('rejects missing, nonboolean, additional or malformed settlement data', () => {
    const values: unknown[] = [
      null,
      undefined,
      [],
      Object.create(settlement()),
      { ...settlement(), execution: null },
      { ...settlement(), extra: true },
      { ...settlement(), [Symbol('extra')]: true },
    ];
    for (const key of Object.keys(settlement())) {
      const missing: Record<string, unknown> = { ...settlement() };
      delete missing[key];
      values.push(missing, Object.defineProperty(settlement(), key, { enumerable: false }));
    }
    for (const value of [undefined, null, 0, 1, 'true', 'false', NaN, Infinity]) {
      values.push(
        { ...settlement(), writerStopped: value },
        { ...settlement(), transientDataRemoved: value },
      );
    }
    for (const value of values) {
      expect(readUploadSecuritySettlement(value)).toBeNull();
      expect(isCompleteUploadSecuritySettlement(value, execution())).toBe(false);
    }
  });

  it('handles nested hostile descriptors and revoked proxies without a false cleanup receipt', () => {
    const get = jest.fn(() => {
      throw new Error('Untrusted cleanup');
    });
    const revoked = Proxy.revocable(settlement(), {});
    revoked.revoke();
    for (const value of [
      revoked.proxy,
      ...Object.keys(settlement()).map((key) => accessor(settlement(), key, get)),
      { ...settlement(), execution: accessor(execution(), 'instanceId', get) },
    ]) {
      expect(readUploadSecuritySettlement(value)).toBeNull();
      expect(isCompleteUploadSecuritySettlement(value, execution())).toBe(false);
    }
    const input = new Proxy(
      { ...settlement(), execution: new Proxy(execution(), { get }) },
      { get },
    );
    expect(readUploadSecuritySettlement(input)).toEqual(settlement());
    expect(isCompleteUploadSecuritySettlement(input, new Proxy(execution(), { get }))).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });
});

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

describe('closed scanner decision and explicit settlement inspection', () => {
  const rejected = () => ({ version: 1, decision: 'rejected', reason: 'classification_marking' });
  const inspection = (decision: unknown = approval()) => ({
    decision,
    settlement: settlement(),
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
  ])('accepts an explicit uninspectable decision for %s with confirmed settlement', (reason) => {
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
        settlement: Object.freeze(Object.assign(Object.create(null), inspection().settlement)),
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
  ])('refuses %s even when settlement is claimed', (_name, decision) => {
    expect(isUploadSecurityDecision(decision)).toBe(false);
    expect(isUploadSecurityInspection(inspection(decision))).toBe(false);
    expect(readUploadSecurityInspection(inspection(decision))).toBeNull();
  });

  it.each([
    ['missing settlement', { decision: rejected() }],
    ['missing decision', { settlement: inspection().settlement }],
    ['bare legacy decision', rejected()],
    ['bare legacy approval', approval()],
    ['null settlement', { ...inspection(), settlement: null }],
    [
      'missing writer acknowledgement',
      { ...inspection(), settlement: { transientDataRemoved: true } },
    ],
    ['missing removal acknowledgement', { ...inspection(), settlement: { writerStopped: true } }],
    [
      'writer not stopped',
      {
        ...inspection(),
        settlement: { ...settlement(), writerStopped: false, transientDataRemoved: true },
      },
    ],
    [
      'transient copies remain',
      {
        ...inspection(),
        settlement: { ...settlement(), writerStopped: true, transientDataRemoved: false },
      },
    ],
    [
      'truthy settlement strings',
      {
        ...inspection(),
        settlement: { ...settlement(), writerStopped: 'true', transientDataRemoved: 'true' },
      },
    ],
    [
      'extra settlement field',
      { ...inspection(), settlement: { ...inspection().settlement, detail: 'private' } },
    ],
    ['extra envelope field', { ...inspection(), version: 1 }],
  ])('refuses %s without inventing an execution settlement', (_name, value) => {
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
        inspection().settlement,
        (settlement: unknown) => isUploadSecurityInspection({ ...inspection(), settlement }),
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
          settlement: new Proxy(value.settlement, { get }),
        },
        { get },
      ),
    );
    expect(snapshot).toEqual(value);
    expect(snapshot).not.toBe(value);
    expect(snapshot?.decision).not.toBe(decision);
    decision.subject.sha256 = 'c'.repeat(64);
    decision.coverage.pages = 0;
    value.settlement.transientDataRemoved = false;
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
        settlement: new Proxy(inspection().settlement, { getOwnPropertyDescriptor: fail }),
      },
    ]) {
      expect(isUploadSecurityInspection(value)).toBe(false);
      expect(readUploadSecurityInspection(value)).toBeNull();
    }
    for (const value of [undefined, null, false, 1, [], new Date(), revoked.proxy])
      expect(isUploadSecurityDecision(value)).toBe(false);
  });
});
