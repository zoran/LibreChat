/** worker-pdf.spec.ts owns original PDF scope/cancellation cases with real parser fixtures and inert AV. */
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { UploadSecurityExecution, UploadSecurityScopeReceipt } from 'librechat-data-provider';
import type { SecurityPdfOcrProvider } from './pdf-ocr';
import { createSecurityWorkerFixture } from './worker-fixture.helper';
import { antivirusReceiptFixture } from './antivirus-fixture.helper';
import { observeSecurityProcess } from './process-observer';
import { createSecurityWorker } from './worker';
const fixture = createSecurityWorkerFixture();
const { signal, subject, worker } = fixture;
describe('original PDF scope through actual worker and built child', () => {
  function document(): Buffer {
    const stream = 'BT /F1 10 Tf 10 50 Td (Synthetic source) Tj ET';
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ];
    let text = '%PDF-1.4\n';
    const offsets = [0];
    for (const [i, item] of objects.entries()) {
      offsets.push(Buffer.byteLength(text));
      text += `${i + 1} 0 obj\n${item}\nendobj\n`;
    }
    const offset = Buffer.byteLength(text);
    text +=
      `xref\n0 ${offsets.length}\n0000000000 65535 f \n` +
      offsets
        .slice(1)
        .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
        .join('');
    return Buffer.from(
      text + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
    );
  }
  function composition() {
    const bytes = document();
    const input = {
      ...subject(),
      mediaType: 'application/pdf',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    let original: UploadSecurityExecution | undefined;
    let pages = 0;
    let retire = true;
    const calls: unknown[] = [];
    const receipt = (): UploadSecurityScopeReceipt | null =>
      original?.custody.kind === 'pdf-ocr' && retire
        ? {
            version: 1,
            scope: original.custody.scope,
            state: 'retired',
            writerStopped: true,
            transientDataRemoved: true,
            dispatchedPages: Array.from({ length: pages }, (_, index) => index + 1),
          }
        : null;
    const session = {
      readPage: jest.fn(async () => {
        pages++;
        return { complete: true, readable: true, text: 'Synthetic text' };
      }),
      close: jest.fn(async () => receipt()),
      cancel: jest.fn(async () => receipt()),
      localCopiesRemoved: () => true,
    };
    const prepare = jest.fn<
      ReturnType<SecurityPdfOcrProvider['prepare']>,
      Parameters<SecurityPdfOcrProvider['prepare']>
    >(async (value) => {
      calls.push({
        execution: value.execution,
        workDeadline: value.workDeadline,
        cleanupDeadline: value.cleanupDeadline,
      });
      original ??= {
        ...value.execution,
        custody: {
          kind: 'pdf-ocr',
          scope: {
            version: 1,
            scopeId: 'scope-fixture',
            attemptId: value.execution.attemptId,
            scannerInstanceId: value.execution.instanceId,
            scannerExecutionId: value.execution.executionId,
            expiresAt: value.execution.expiresAt,
            documentSha256: input.sha256,
            pageLimit: 32,
            requestIdScheme: 'cortex-ocr-page-sha256-v1',
            workDeadline: value.workDeadline,
            cleanupDeadline: value.cleanupDeadline,
            providerBinding: {
              podUid: 'pod-fixture',
              containerId: 'a'.repeat(64),
              runtimeImage: 'registry.invalid/ocr@sha256:' + 'b'.repeat(64),
              sourceManifestSha256: 'c'.repeat(64),
              modelRevision: 'aaa02f3811945a91062062994c5c4a3f4c0af2b0',
              profileSha256: 'd'.repeat(64),
              apiIncarnation: 'api-fixture',
              engineIncarnation: 'engine-fixture',
              workerIncarnation: 'worker-fixture',
            },
          },
        },
      };
      return original;
    });
    const provider: SecurityPdfOcrProvider = { prepare, open: () => session };
    const launcher = {
      run: jest.fn(
        async (
          request: Parameters<
            NonNullable<Parameters<typeof createSecurityWorker>[0]['pdf']>['launcher']['run']
          >[0],
        ) => {
          const child = spawn(
            process.execPath,
            [join(__dirname, '../../../dist/uploads/security/pdf-child.cjs')],
            {
              stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
              env: { NODE_ENV: 'test' },
            },
          );
          const joined = new Promise<void>((resolve) => child.once('close', () => resolve()));
          try {
            return await observeSecurityProcess({ child, ...request });
          } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            await joined;
          }
        },
      ),
    };
    const instance = worker({ pdf: { provider, launcher } });
    return {
      bytes,
      input,
      prepare,
      instance,
      provider,
      launcher,
      session,
      calls,
      unknown: () => {
        retire = false;
      },
      known: () => {
        retire = true;
      },
    };
  }
  it('does no content work before prepare returns and joins actual parser/pages plus original provider before approval', async () => {
    const test = composition();
    const execution = await test.instance.prepare({
      attemptId: 'upload.1',
      subject: test.input,
      signal: signal(),
    });
    expect(test.session.readPage).not.toHaveBeenCalled();
    expect(test.launcher.run).not.toHaveBeenCalled();
    const result = await test.instance.inspect({
      execution,
      subject: test.input,
      signal: signal(),
      body: (async function* () {
        yield test.bytes;
      })(),
    });
    expect(result.decision).toMatchObject({
      decision: 'approved',
      coverage: { complete: true, pages: 1, parts: 1 },
    });
    expect(result.settlement).toMatchObject({
      execution,
      antivirusReceipt: antivirusReceiptFixture(execution),
      writerStopped: true,
      transientDataRemoved: true,
      providerReceipt: { state: 'retired', dispatchedPages: [1] },
    });
    expect(test.session.close).toHaveBeenCalledTimes(1);
    expect(test.launcher.run).toHaveBeenCalledTimes(1);
  });
  it('retries lost inert prepare acknowledgement with the same original IDs and both cutoffs', async () => {
    const test = composition();
    const implementation = test.prepare.getMockImplementation()!;
    test.prepare.mockImplementationOnce(async (input) => {
      await implementation(input);
      throw new Error('fixture-lost-ack');
    });
    await expect(
      test.instance.prepare({ attemptId: 'upload.1', subject: test.input, signal: signal() }),
    ).rejects.toThrow();
    expect(test.session.readPage).not.toHaveBeenCalled();
    const execution = await test.instance.prepare({
      attemptId: 'upload.1',
      subject: test.input,
      signal: signal(),
    });
    expect(test.calls).toHaveLength(2);
    expect(test.calls[0]).toEqual(test.calls[1]);
    expect(await test.instance.cancel({ execution, signal: signal() })).toMatchObject({
      providerReceipt: { state: 'retired', dispatchedPages: [] },
    });
  });
  it('withholds a complete local parse while the original API retirement is unknown, then observes only that scope', async () => {
    const test = composition();
    const execution = await test.instance.prepare({
      attemptId: 'upload.1',
      subject: test.input,
      signal: signal(),
    });
    test.unknown();
    await expect(
      test.instance.inspect({
        execution,
        subject: test.input,
        signal: signal(),
        body: (async function* () {
          yield test.bytes;
        })(),
      }),
    ).rejects.toThrow();
    expect(await test.instance.maintenance.getMaintenanceCensus(null)).toMatchObject({
      pendingWrites: 1,
      complete: false,
    });
    expect(await test.instance.cancel({ execution, signal: signal() })).toMatchObject({
      providerReceipt: null,
    });
    test.known();
    expect(await test.instance.cancel({ execution, signal: signal() })).toMatchObject({
      providerReceipt: { state: 'retired' },
    });
    expect(test.session.readPage).toHaveBeenCalledTimes(1);
  });
  it('a replacement scanner cannot combine remote retirement with invented original local cleanup', async () => {
    const test = composition();
    const execution = await test.instance.prepare({
      attemptId: 'upload.1',
      subject: test.input,
      signal: signal(),
    });
    const replacement = worker({ pdf: { provider: test.provider, launcher: test.launcher } });
    expect(await replacement.cancel({ execution, signal: signal() })).toMatchObject({
      writerStopped: false,
      transientDataRemoved: false,
      providerReceipt: { state: 'retired', dispatchedPages: [] },
    });
    expect(test.launcher.run).not.toHaveBeenCalled();
  });
});
