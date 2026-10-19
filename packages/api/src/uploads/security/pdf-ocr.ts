/** Trusted scanner-side OCR custody. Parser children never receive this endpoint or its secrets. */
import { request } from 'node:https';
import { TLSSocket } from 'node:tls';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import {
  readUploadSecurityExecution,
  readUploadSecurityScopeReceipt,
} from 'librechat-data-provider';
import type {
  UploadSecurityExecution,
  UploadSecurityProviderBinding,
  UploadSecurityProviderScope,
  UploadSecurityScopeReceipt,
  UploadSecuritySubject,
} from 'librechat-data-provider';
import type { PdfSecurityOcr } from './pdf';
import { createPinnedServiceEndpoint } from '../intake/endpoint';

type Prepared = {
  execution: UploadSecurityExecution;
  subject: UploadSecuritySubject;
  workDeadline: number;
  cleanupDeadline: number;
  signal: AbortSignal;
};
export type SecurityPdfOcrSession = PdfSecurityOcr & {
  close(signal: AbortSignal): Promise<UploadSecurityScopeReceipt | null>;
  cancel(signal: AbortSignal): Promise<UploadSecurityScopeReceipt | null>;
  localCopiesRemoved(): boolean;
};
export type SecurityPdfOcrProvider = {
  prepare(input: Prepared): Promise<UploadSecurityExecution>;
  open(execution: UploadSecurityExecution): SecurityPdfOcrSession;
};
type FixedBinding = Omit<
  UploadSecurityProviderBinding,
  'apiIncarnation' | 'engineIncarnation' | 'workerIncarnation'
>;
export type SecurityPdfOcrConfiguration = {
  endpoint: string;
  allowedHosts: readonly string[];
  certificateSha256: string;
  apiKey: string;
  tls: { ca: string | Buffer; cert: string | Buffer; key: string | Buffer };
  binding: FixedBinding;
};
const failure = () => new Error('PDF security provider unavailable');
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return (
    Reflect.ownKeys(descriptors).length === keys.length &&
    keys.every((key) => descriptors[key] && 'value' in descriptors[key])
  );
};
function pdfExecution(value: unknown): UploadSecurityExecution & {
  custody: { kind: 'pdf-ocr'; scope: UploadSecurityProviderScope };
} {
  const execution = readUploadSecurityExecution(value);
  if (!execution || execution.custody.kind !== 'pdf-ocr') throw failure();
  return { ...execution, custody: execution.custody };
}
export function securityPdfPageRequestId(scope: UploadSecurityProviderScope, page: number): string {
  if (!Number.isSafeInteger(page) || page < 1 || page > 32) throw failure();
  return (
    'chatcmpl-' +
    sha(
      JSON.stringify([
        1,
        scope.scopeId,
        scope.scannerExecutionId,
        scope.providerBinding.apiIncarnation,
        scope.providerBinding.engineIncarnation,
        scope.documentSha256,
        page,
      ]),
    )
  );
}

/** Full API/body plus engine/worker receipt; an engine bit or SSE completion is insufficient. */
export function isRetiredSecurityPdfPage(
  value: unknown,
  execution: UploadSecurityExecution,
  page: number,
  pngSha256: string,
  rasterSha256: string,
): boolean {
  try {
    const original = pdfExecution(execution);
    const scope = original.custody.scope;
    if (
      !exact(value, [
        'version',
        'scope',
        'page',
        'requestId',
        'pngSha256',
        'rasterSha256',
        'resultState',
        'state',
        'writerStopped',
        'transientDataRemoved',
        'engineReceipt',
      ]) ||
      value.version !== 1 ||
      value.page !== page ||
      value.requestId !== securityPdfPageRequestId(scope, page) ||
      value.pngSha256 !== pngSha256 ||
      value.rasterSha256 !== rasterSha256 ||
      value.state !== 'retired' ||
      value.writerStopped !== true ||
      value.transientDataRemoved !== true ||
      value.resultState !== 'completed'
    )
      return false;
    const matched = readUploadSecurityScopeReceipt(
      {
        version: 1,
        scope: value.scope,
        state: 'retired',
        writerStopped: true,
        transientDataRemoved: true,
        dispatchedPages: [],
      },
      original,
    );
    if (!matched) return false;
    const engine = value.engineReceipt;
    if (
      !exact(engine, [
        'engineIncarnation',
        'externalId',
        'workDeadline',
        'deadline',
        'workerIncarnation',
        'internalId',
        'state',
        'worker',
      ]) ||
      engine.engineIncarnation !== scope.providerBinding.engineIncarnation ||
      engine.workerIncarnation !== scope.providerBinding.workerIncarnation ||
      engine.externalId !== value.requestId ||
      engine.workDeadline !== scope.workDeadline ||
      engine.deadline !== scope.cleanupDeadline ||
      engine.state !== 'engine_retired' ||
      typeof engine.internalId !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,256}$/.test(engine.internalId)
    )
      return false;
    const worker = engine.worker;
    return (
      exact(worker, ['requestId', 'workerIncarnation', 'gpuSynchronized', 'copiesCleared']) &&
      worker.requestId === engine.internalId &&
      worker.workerIncarnation === engine.workerIncarnation &&
      worker.gpuSynchronized === true &&
      worker.copiesCleared === true
    );
  } catch {
    return false;
  }
}

/** Pinned OCR2 native token oracle. Valid completion is still distinct from page retirement. */
export function readSecurityPdfOcrStream(bytes: Uint8Array, requestId: string): string {
  if (bytes.byteLength < 1 || bytes.byteLength > 4 * 1024 * 1024) throw failure();
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let prompt: number | undefined;
  let generated = 0;
  let last: number | undefined;
  let terminal = false;
  let done = false;
  let finish: unknown;
  let text = '';
  let usage: Record<string, unknown> = {};
  const tokens = (value: unknown, maximum: number): number[] => {
    if (
      !Array.isArray(value) ||
      value.length > maximum ||
      value.some((token) => !Number.isSafeInteger(token) || token < 0 || token >= 2 ** 31)
    )
      throw failure();
    return value;
  };
  for (const line of source.split(/\r?\n/)) {
    if (!line) continue;
    if (!line.startsWith('data: ')) throw failure();
    if (done) throw failure();
    const data = line.slice(6);
    if (data === '[DONE]') {
      done = true;
      continue;
    }
    const event = JSON.parse(data);
    if (
      !event ||
      event.id !== requestId ||
      !Array.isArray(event.choices) ||
      event.choices.length > 1
    )
      throw failure();
    if (event.prompt_token_ids != null) {
      if (prompt !== undefined || generated !== 0) throw failure();
      const ids = tokens(event.prompt_token_ids, 4096);
      if (
        ids[0] !== 0 ||
        ids.filter((id) => id === 0).length !== 1 ||
        ![257, 545, 689, 833, 977, 1121].includes(ids.filter((id) => id === 128815).length)
      )
        throw failure();
      prompt = ids.length;
    }
    for (const choice of event.choices) {
      if (choice.index !== 0 || !choice.delta || typeof choice.delta !== 'object') throw failure();
      const ids = choice.token_ids == null ? [] : tokens(choice.token_ids, 4096 - generated);
      for (const key of ['content', 'reasoning', 'reasoning_content']) {
        const value = choice.delta[key];
        if (value != null && typeof value !== 'string') throw failure();
        if (value) {
          if (!ids.length || terminal || last === 1) throw failure();
          // Reasoning is also inspected as text; it cannot conceal a marking from the parser.
          text += value;
          if (Buffer.byteLength(text) > 65_536) throw failure();
        }
      }
      if (ids.length) {
        if (prompt === undefined || terminal || last === 1 || ids.slice(0, -1).includes(1))
          throw failure();
        generated += ids.length;
        last = ids[ids.length - 1];
      }
      if (choice.stop_reason != null) throw failure();
      if (choice.finish_reason != null) {
        if (terminal) throw failure();
        terminal = true;
        finish = choice.finish_reason;
      }
    }
    if (event.usage != null) {
      if (typeof event.usage !== 'object') throw failure();
      usage = event.usage;
    }
  }
  if (
    !done ||
    !terminal ||
    finish !== 'stop' ||
    last !== 1 ||
    generated < 1 ||
    prompt === undefined ||
    (usage.prompt_tokens != null && usage.prompt_tokens !== prompt) ||
    (usage.completion_tokens != null && usage.completion_tokens !== generated)
  )
    throw failure();
  // A nonempty native grounding envelope prevents an empty/EOS-only result becoming readable.
  const grounded = text.replace(/<｜end▁of▁sentence｜>\s*$/, '').trim();
  const pattern = /<\|ref\|>([a-z_ -]{1,32})<\|\/ref\|><\|det\|>([\s\S]{1,512}?)<\|\/det\|>/g;
  const blocks = [...grounded.matchAll(pattern)];
  if (!blocks.length || blocks.length > 128 || grounded.slice(0, blocks[0].index).trim())
    throw failure();
  for (let index = 0; index < blocks.length; index++) {
    const match = blocks[index];
    const boxes = JSON.parse(match[2]);
    if (
      !Array.isArray(boxes) ||
      !boxes.length ||
      boxes.length > 16 ||
      boxes.some(
        (box) =>
          !Array.isArray(box) ||
          box.length !== 4 ||
          box.some((n) => !Number.isSafeInteger(n) || n < 0 || n > 999) ||
          box[0] >= box[2] ||
          box[1] >= box[3],
      )
    )
      throw failure();
    const body = grounded.slice(match.index! + match[0].length, blocks[index + 1]?.index).trim();
    if (!body || body.length > 4096 || /<\|\/?(?:ref|det)\|>/.test(body)) throw failure();
  }
  return text;
}

/** The deployment owns immutable identity and an admitted OCR profile; this does not qualify it. */
export function createSecurityPdfOcrProvider(
  options: SecurityPdfOcrConfiguration,
): SecurityPdfOcrProvider {
  const endpoint = createPinnedServiceEndpoint(options);
  const binding = { ...options.binding };
  const fixedKeys = [
    'podUid',
    'containerId',
    'runtimeImage',
    'sourceManifestSha256',
    'modelRevision',
    'profileSha256',
  ];
  if (
    !exact(options.binding, fixedKeys) ||
    !/^[a-f0-9]{64}$/.test(options.certificateSha256) ||
    typeof options.apiKey !== 'string' ||
    !/^[\x21-\x7e]{1,4096}$/.test(options.apiKey) ||
    binding.modelRevision !== 'aaa02f3811945a91062062994c5c4a3f4c0af2b0'
  )
    throw failure();
  const certificateSha256 = options.certificateSha256;
  const apiKey = options.apiKey;
  const tls = {
    ca: Buffer.from(options.tls.ca),
    cert: Buffer.from(options.tls.cert),
    key: Buffer.from(options.tls.key),
  };
  if (Object.values(tls).some((bytes) => !bytes.length || bytes.length > 65_536)) throw failure();
  const matches = (scope: UploadSecurityProviderScope) =>
    fixedKeys.every(
      (key) =>
        scope.providerBinding[key as keyof FixedBinding] === binding[key as keyof FixedBinding],
    );

  async function call(
    route: 'prepare' | 'page' | 'settle' | 'close' | 'cancel',
    value: unknown,
    cutoff: number,
    signal: AbortSignal,
    localEnd = Number.POSITIVE_INFINITY,
  ): Promise<Buffer> {
    const remaining = Math.min(cutoff * 1000 - Date.now(), localEnd - performance.now());
    if (signal.aborted || remaining <= 0 || remaining > 31_000) throw failure();
    const end = performance.now() + remaining;
    const payload = Buffer.from(JSON.stringify(value));
    if (payload.length > (route === 'page' ? 6 * 1024 * 1024 : 8192)) {
      payload.fill(0);
      throw failure();
    }
    const maximum = route === 'page' ? 4 * 1024 * 1024 : 16384;
    const received = Buffer.alloc(maximum);
    let length = 0;
    let response: import('node:http').IncomingMessage | undefined;
    let responseClosed: Promise<void> = Promise.resolve();
    let req: ReturnType<typeof request> | undefined;
    let requestClosed: Promise<void> = Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      req?.destroy(failure());
      response?.destroy(failure());
    };
    try {
      req = request(new URL('/v1/cortex/ocr/' + route, endpoint.url), {
        method: 'POST',
        ...tls,
        agent: false,
        lookup: endpoint.lookup,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.3',
        maxHeaderSize: 8192,
        headers: {
          authorization: 'Bearer ' + apiKey,
          'content-type': 'application/json',
          'content-length': String(payload.length),
        },
      });
      requestClosed = new Promise((resolve) => req!.once('close', resolve));
      const complete = new Promise<void>((resolve, reject) => {
        req!.on('error', () => reject(failure()));
        req!.once('response', (res) => {
          response = res;
          responseClosed = new Promise((joined) => res.once('close', joined));
          const type = route === 'page' ? 'text/event-stream' : 'application/json';
          if (
            res.statusCode !== 200 ||
            res.headers['content-encoding'] !== undefined ||
            (res.headers['content-type'] !== type &&
              res.headers['content-type'] !== type + '; charset=utf-8')
          ) {
            reject(failure());
            res.destroy();
            return;
          }
          res.on('error', () => reject(failure()));
          res.once('aborted', () => reject(failure()));
          res.on('data', (chunk: Buffer) => {
            try {
              if (
                !Buffer.isBuffer(chunk) ||
                length + chunk.length > maximum ||
                performance.now() >= end
              )
                throw failure();
              received.set(chunk, length);
              length += chunk.length;
            } catch {
              reject(failure());
              abort();
            } finally {
              if (Buffer.isBuffer(chunk)) chunk.fill(0);
            }
          });
          res.once('end', () => (res.complete ? resolve() : reject(failure())));
        });
      });
      void complete.catch(() => undefined);
      timer = setTimeout(abort, remaining);
      timer.unref();
      signal.addEventListener('abort', abort, { once: true });
      await new Promise<void>((resolve, reject) => {
        req!.once('error', () => reject(failure()));
        req!.once('socket', (socket) => {
          if (!(socket instanceof TLSSocket)) {
            reject(failure());
            return;
          }
          socket.once('secureConnect', () => {
            const peer = socket.getPeerCertificate();
            if (socket.authorized && peer.raw && sha(peer.raw) === certificateSha256) {
              resolve();
            } else {
              reject(failure());
            }
          });
        });
      });
      if (signal.aborted || performance.now() >= end) throw failure();
      req.end(payload);
      await complete;
      if (signal.aborted || performance.now() >= end) throw failure();
      return Buffer.from(received.subarray(0, length));
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      req?.destroy();
      response?.destroy();
      await Promise.all([requestClosed, responseClosed]);
      payload.fill(0);
      received.fill(0);
    }
  }
  async function json(
    route: 'prepare' | 'settle' | 'close' | 'cancel',
    payload: unknown,
    cutoff: number,
    signal: AbortSignal,
    localEnd = Number.POSITIVE_INFINITY,
  ): Promise<unknown> {
    const bytes = await call(route, payload, cutoff, signal, localEnd);
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } finally {
      bytes.fill(0);
    }
  }
  return {
    async prepare(input) {
      const original = readUploadSecurityExecution(input.execution);
      if (
        !original ||
        original.custody.kind !== 'none' ||
        input.subject.mediaType !== 'application/pdf'
      )
        throw failure();
      const scope = await json(
        'prepare',
        {
          attemptId: original.attemptId,
          instanceId: original.instanceId,
          executionId: original.executionId,
          documentSha256: input.subject.sha256,
          expiresAt: original.expiresAt,
          workDeadline: input.workDeadline,
          cleanupDeadline: input.cleanupDeadline,
        },
        input.cleanupDeadline,
        input.signal,
      );
      const execution = pdfExecution({ ...original, custody: { kind: 'pdf-ocr', scope } });
      if (
        !matches(execution.custody.scope) ||
        execution.custody.scope.documentSha256 !== input.subject.sha256 ||
        execution.custody.scope.workDeadline !== input.workDeadline ||
        execution.custody.scope.cleanupDeadline !== input.cleanupDeadline
      )
        throw failure();
      return execution;
    },
    open(value) {
      const execution = pdfExecution(value);
      const scope = execution.custody.scope;
      if (!matches(scope)) throw failure();
      const origin = performance.now();
      const wall = Date.now();
      const workEnd = origin + Math.min(30_000, scope.workDeadline * 1000 - wall);
      const cleanupEnd = origin + Math.min(31_000, scope.cleanupDeadline * 1000 - wall);
      let pages = 0;
      let pixels = 0;
      let outputBytes = 0;
      let active = 0;
      let closed = false;
      let failed = false;
      const finish = async (route: 'close' | 'cancel', signal: AbortSignal) => {
        closed = true;
        try {
          const result = readUploadSecurityScopeReceipt(
            await json(route, { scope }, scope.cleanupDeadline, signal, cleanupEnd),
            execution,
          );
          if (
            !result ||
            (route === 'close' &&
              (active !== 0 || failed || result.dispatchedPages.length !== pages))
          )
            return null;
          return result;
        } catch {
          return null;
        }
      };
      return {
        localCopiesRemoved: () => active === 0,
        close: (signal) => finish('close', signal),
        cancel: (signal) => finish('cancel', signal),
        async readPage(input) {
          if (
            closed ||
            failed ||
            active ||
            input.page !== pages + 1 ||
            input.page > 32 ||
            !Number.isSafeInteger(input.width) ||
            !Number.isSafeInteger(input.height) ||
            input.width < 1 ||
            input.height < 1 ||
            !Number.isSafeInteger(input.width * input.height) ||
            input.width * input.height > 8_000_000 ||
            (pixels += input.width * input.height) > 64_000_000 ||
            !(input.rgba instanceof Uint8ClampedArray) ||
            input.rgba.buffer instanceof SharedArrayBuffer ||
            input.rgba.length !== input.width * input.height * 4 ||
            Date.now() >= scope.workDeadline * 1000 ||
            performance.now() >= workEnd
          )
            throw failure();
          active++;
          let png: Buffer | undefined;
          let stream: Buffer | undefined;
          const canvas = createCanvas(input.width, input.height);
          try {
            const rasterSha256 = sha(
              new Uint8Array(input.rgba.buffer, input.rgba.byteOffset, input.rgba.byteLength),
            );
            const context = canvas.getContext('2d');
            context.putImageData(new ImageData(input.rgba, input.width, input.height), 0, 0);
            png = canvas.encodeSync('png');
            if (png.length > 4 * 1024 * 1024) throw failure();
            const pngSha256 = sha(png);
            // Increment before dispatch: lost response must never cause replay of page bytes.
            pages++;
            stream = await call(
              'page',
              {
                scope,
                page: input.page,
                width: input.width,
                height: input.height,
                rasterSha256,
                pngSha256,
                png: png.toString('base64'),
              },
              scope.workDeadline,
              input.signal,
              workEnd,
            );
            const text = readSecurityPdfOcrStream(
              stream,
              securityPdfPageRequestId(scope, input.page),
            );
            if ((outputBytes += Buffer.byteLength(text)) > 1024 * 1024) throw failure();
            const receipt = await json(
              'settle',
              { scope, page: input.page },
              scope.cleanupDeadline,
              input.signal,
              cleanupEnd,
            );
            if (!isRetiredSecurityPdfPage(receipt, execution, input.page, pngSha256, rasterSha256))
              throw failure();
            return { complete: true, readable: true, text };
          } catch (error) {
            failed = true;
            throw error;
          } finally {
            png?.fill(0);
            stream?.fill(0);
            canvas.width = 0;
            canvas.height = 0;
            active--;
          }
        },
      };
    },
  };
}
