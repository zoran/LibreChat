/** upload-security-execution.spec.ts checks original execution/PDF custody and joined retirement. */
import {
  readUploadSecuritySubject,
  readUploadSecurityExecution,
  readUploadSecuritySettlement,
  matchesUploadSecurityExecution,
  isCompleteUploadSecuritySettlement,
} from './upload-security';
import { now, subject, execution, settlement, accessor } from './__fixtures__/upload-security';
import { antivirusFixture } from './__fixtures__/upload-antivirus';

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
      antivirusReceipt: {
        ...antivirusFixture(subject(), now, original.expiresAt).receipt,
        custody:
          'antivirus' in original
            ? original.antivirus
            : antivirusFixture(subject(), now, original.expiresAt).custody,
      },
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
      const [operationId, generation] = attemptId.split('.');
      const av = antivirusFixture(
        { ...subject(), operationId, transferGeneration: Number(generation) },
        now,
        execution().expiresAt,
      );
      const input = Object.freeze(
        Object.assign(Object.create(null), execution(), { attemptId, antivirus: av.custody }),
      );
      const result = readUploadSecurityExecution(input)!;
      expect(result).toEqual(input);
      expect(result).not.toBe(input);
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    }
    const historical = execution();
    historical.expiresAt = '1970-01-01T00:01:00.000Z';
    if (historical.version === 3) {
      historical.antivirus.expiresAt = historical.expiresAt;
      historical.antivirus.dailyPublishedAt = '1970-01-01T00:00:00.000Z';
    }
    expect(readUploadSecurityExecution(historical)).not.toBeNull();
  });

  it.each([
    ['legacy version', { version: 1 }],
    ['future version', { version: 4 }],
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
