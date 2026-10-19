/** Actual local mTLS/PNG/SSE; the fixed provider fixture is not a GPU or OCR quality qualification. */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { createHash, X509Certificate } from 'node:crypto';
import type { UploadSecurityExecution, UploadSecurityProviderScope } from 'librechat-data-provider';
import type { AddressInfo } from 'node:net';
import {
  createSecurityPdfOcrProvider,
  isRetiredSecurityPdfPage,
  securityPdfPageRequestId,
  readSecurityPdfOcrStream,
} from './pdf-ocr';
import { createSecurityTlsFixture } from './tls-fixture.helper';

const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const binding = {
  podUid: '11111111-1111-4111-8111-111111111111',
  containerId: 'a'.repeat(64),
  runtimeImage: 'registry.invalid/ocr@sha256:' + 'b'.repeat(64),
  sourceManifestSha256: 'c'.repeat(64),
  modelRevision: 'aaa02f3811945a91062062994c5c4a3f4c0af2b0',
  profileSha256: 'd'.repeat(64),
};
const providerBinding = {
  ...binding,
  apiIncarnation: 'api-fixture',
  engineIncarnation: 'engine-fixture',
  workerIncarnation: 'worker-fixture',
};
function original(): UploadSecurityExecution {
  return {
    version: 2,
    attemptId: 'upload.1',
    instanceId: '22222222-2222-4222-8222-222222222222',
    executionId: '33333333-3333-4333-8333-333333333333',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    custody: { kind: 'none' },
  };
}
const subject = {
  tenantId: 'tenant',
  userId: 'user',
  operationId: 'upload',
  transferGeneration: 1,
  mediaType: 'application/pdf',
  bytes: 10,
  sha256: 'e'.repeat(64),
};
function scope(execution = original()): UploadSecurityProviderScope {
  return {
    version: 1,
    scopeId: 'scope-fixture',
    attemptId: execution.attemptId,
    scannerInstanceId: execution.instanceId,
    scannerExecutionId: execution.executionId,
    expiresAt: execution.expiresAt,
    documentSha256: subject.sha256,
    pageLimit: 32,
    requestIdScheme: 'cortex-ocr-page-sha256-v1',
    workDeadline: Date.now() / 1000 + 10,
    cleanupDeadline: Date.now() / 1000 + 11,
    providerBinding,
  };
}
function pageReceipt(
  originalScope: UploadSecurityProviderScope,
  page = 1,
  pngSha256 = 'f'.repeat(64),
  rasterSha256 = '9'.repeat(64),
) {
  const requestId = securityPdfPageRequestId(originalScope, page);
  return {
    version: 1,
    scope: originalScope,
    page,
    requestId,
    pngSha256,
    rasterSha256,
    resultState: 'completed',
    state: 'retired',
    writerStopped: true,
    transientDataRemoved: true,
    engineReceipt: {
      engineIncarnation: providerBinding.engineIncarnation,
      externalId: requestId,
      workDeadline: originalScope.workDeadline,
      deadline: originalScope.cleanupDeadline,
      workerIncarnation: providerBinding.workerIncarnation,
      internalId: 'internal-fixture',
      state: 'engine_retired',
      worker: {
        requestId: 'internal-fixture',
        workerIncarnation: providerBinding.workerIncarnation,
        gpuSynchronized: true,
        copiesCleared: true,
      },
    },
  };
}
const groundedText =
  '<|ref|>text<|/ref|><|det|>[[0,0,999,999]]<|/det|>Synthetic readable text<｜end▁of▁sentence｜>';
function events(id: string) {
  return [
    { id, prompt_token_ids: [0, ...Array(257).fill(128815)], choices: [] },
    {
      id,
      choices: [
        {
          index: 0,
          delta: { content: groundedText },
          token_ids: [10, 1],
          finish_reason: 'stop',
          stop_reason: null,
        },
      ],
    },
    { id, choices: [], usage: { prompt_tokens: 258, completion_tokens: 2 } },
  ];
}
const stream = (rows: unknown[], done = true) =>
  Buffer.from(
    rows.map((row) => 'data: ' + JSON.stringify(row) + '\n\n').join('') +
      (done ? 'data: [DONE]\n\n' : ''),
  );

describe('native result and full page retirement', () => {
  it('accepts original native token and grounding evidence independently from cleanup', () => {
    expect(readSecurityPdfOcrStream(stream(events('chatcmpl-fixture')), 'chatcmpl-fixture')).toBe(
      groundedText,
    );
  });
  it.each([
    'wrong-id',
    'missing-prompt',
    'missing-eos',
    'truncated',
    'missing-image',
    'late-text',
    'empty-grounding',
    'wrong-usage',
  ])('rejects %s despite superficially successful completion', (mode) => {
    const rows = events('chatcmpl-fixture');
    if (mode === 'wrong-id') rows[0].id = 'chatcmpl-foreign';
    if (mode === 'missing-prompt') rows.shift();
    if (mode === 'missing-image') rows[0].prompt_token_ids = [0, 128815];
    if (mode === 'wrong-usage') rows[2].usage!.completion_tokens = 3;
    if (mode === 'missing-eos') rows[1].choices[0].token_ids = [10, 2];
    if (mode === 'empty-grounding') rows[1].choices[0].delta.content = '';
    if (mode === 'late-text') rows.push(rows[1]);
    expect(() =>
      readSecurityPdfOcrStream(stream(rows, mode !== 'truncated'), 'chatcmpl-fixture'),
    ).toThrow();
  });
  it.each([
    'api-body',
    'engine-only',
    'worker',
    'engine',
    'original-clock',
    'page',
    'digest',
    'scope',
  ])('keeps %s retirement mismatch held', (mode) => {
    const execution = original();
    const originalScope = scope(execution);
    execution.custody = { kind: 'pdf-ocr', scope: originalScope };
    const receipt = pageReceipt(originalScope);
    expect(isRetiredSecurityPdfPage(receipt, execution, 1, 'f'.repeat(64), '9'.repeat(64))).toBe(
      true,
    );
    if (mode === 'api-body') receipt.transientDataRemoved = false;
    if (mode === 'worker') receipt.engineReceipt.worker.workerIncarnation = 'replacement';
    if (mode === 'engine') receipt.engineReceipt.engineIncarnation = 'replacement';
    if (mode === 'original-clock') receipt.engineReceipt.deadline += 1;
    if (mode === 'page') receipt.page++;
    if (mode === 'digest') receipt.pngSha256 = '0'.repeat(64);
    if (mode === 'scope') receipt.scope = { ...originalScope, scopeId: 'replacement' };
    expect(
      isRetiredSecurityPdfPage(
        mode === 'engine-only' ? receipt.engineReceipt : receipt,
        execution,
        1,
        'f'.repeat(64),
        '9'.repeat(64),
      ),
    ).toBe(false);
  });
});

describe('actual trusted scanner-to-provider mTLS composition', () => {
  let fixture: ReturnType<typeof createSecurityTlsFixture>;
  const servers: ReturnType<typeof createServer>[] = [];
  const pem = (name: string) => readFileSync(join(fixture.directory, name));
  beforeAll(() => {
    fixture = createSecurityTlsFixture();
  });
  afterAll(() => fixture.close());
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.closeAllConnections();
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
  });
  async function setup(fault = '') {
    const calls: string[] = [];
    let dispatched = 0;
    let prepared: UploadSecurityProviderScope | undefined;
    let pageBody: Record<string, unknown> = {};
    const server = createServer(
      {
        ca: pem('ca.pem'),
        cert: pem('server.pem'),
        key: pem('server.key'),
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.3',
      },
      (req, res) => {
        void (async () => {
          expect(req.headers.authorization).toBe('Bearer fixture-ocr-provider-key');
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk);
          const payload = Buffer.concat(chunks);
          const body = JSON.parse(payload.toString());
          payload.fill(0);
          chunks.forEach((chunk) => chunk.fill(0));
          calls.push(req.url!);
          let answer: unknown;
          if (req.url?.endsWith('/prepare')) {
            prepared ??= {
              version: 1,
              scopeId: 'scope-fixture',
              attemptId: body.attemptId,
              scannerInstanceId: body.instanceId,
              scannerExecutionId: body.executionId,
              expiresAt: body.expiresAt,
              documentSha256: body.documentSha256,
              pageLimit: 32,
              requestIdScheme: 'cortex-ocr-page-sha256-v1',
              workDeadline: body.workDeadline,
              cleanupDeadline: body.cleanupDeadline,
              providerBinding,
            };
            answer = prepared;
          } else {
            expect(body.scope).toEqual(prepared);
            if (req.url?.endsWith('/page')) {
              dispatched++;
              pageBody = body;
              const png = Buffer.from(body.png, 'base64');
              expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
              expect(hash(png)).toBe(body.pngSha256);
              png.fill(0);
              if (fault === 'lost-page-response') {
                res.destroy();
                return;
              }
              res.setHeader('content-type', 'text/event-stream; charset=utf-8');
              res.end(stream(events(securityPdfPageRequestId(prepared!, body.page))));
              return;
            }
            if (req.url?.endsWith('/settle')) {
              answer = {
                ...pageReceipt(
                  prepared!,
                  body.page,
                  String(pageBody.pngSha256),
                  String(pageBody.rasterSha256),
                ),
                transientDataRemoved: fault !== 'unretired-api',
              };
            } else
              answer = {
                version: 1,
                scope: prepared,
                state: 'retired',
                writerStopped: true,
                transientDataRemoved: true,
                dispatchedPages: Array.from({ length: dispatched }, (_, index) => index + 1),
              };
          }
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(answer));
        })().catch(() => {
          res.destroy();
        });
      },
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const provider = createSecurityPdfOcrProvider({
      endpoint: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
      allowedHosts: ['127.0.0.1'],
      certificateSha256:
        fault === 'wrong-certificate'
          ? '0'.repeat(64)
          : hash(new X509Certificate(pem('server.pem')).raw),
      apiKey: 'fixture-ocr-provider-key',
      binding,
      tls: { ca: pem('ca.pem'), cert: pem('client.pem'), key: pem('client.key') },
    });
    const originalExecution = original();
    const workDeadline = Date.now() / 1000 + 10;
    const prepare = () =>
      provider.prepare({
        execution: originalExecution,
        subject,
        workDeadline,
        cleanupDeadline: workDeadline + 1,
        signal: AbortSignal.timeout(5000),
      });
    return { provider, prepare, calls, dispatched: () => dispatched };
  }
  const page = () => ({
    page: 1,
    width: 2,
    height: 2,
    rgba: new Uint8ClampedArray(16).fill(255),
    signal: AbortSignal.timeout(5000),
  });
  it('prepares inertly, preserves exact scope on replay, retires every page before returning text and closes the document', async () => {
    const test = await setup();
    const execution = await test.prepare();
    expect(test.dispatched()).toBe(0);
    expect(await test.prepare()).toEqual(execution);
    const session = test.provider.open(execution);
    expect(await session.readPage(page())).toEqual({
      complete: true,
      readable: true,
      text: groundedText,
    });
    expect(test.calls.slice(-2)).toEqual(['/v1/cortex/ocr/page', '/v1/cortex/ocr/settle']);
    expect(session.localCopiesRemoved()).toBe(true);
    expect(await session.close(AbortSignal.timeout(5000))).toMatchObject({
      state: 'retired',
      dispatchedPages: [1],
    });
    await expect(session.readPage(page())).rejects.toThrow();
    expect(test.dispatched()).toBe(1);
  });
  it.each(['lost-page-response', 'unretired-api'])(
    'never resends page bytes after %s and observes only original-scope cancellation',
    async (fault) => {
      const test = await setup(fault);
      const session = test.provider.open(await test.prepare());
      await expect(session.readPage(page())).rejects.toThrow();
      await expect(session.readPage(page())).rejects.toThrow();
      expect(await session.close(AbortSignal.timeout(5000))).toBeNull();
      expect(await session.cancel(AbortSignal.timeout(5000))).toMatchObject({
        state: 'retired',
        dispatchedPages: [1],
      });
      expect(test.dispatched()).toBe(1);
      expect(session.localCopiesRemoved()).toBe(true);
    },
  );
  it('does not send a request body or bearer header before exact authenticated peer verification', async () => {
    const test = await setup('wrong-certificate');
    await expect(test.prepare()).rejects.toThrow();
    expect(test.calls).toEqual([]);
  });
});
