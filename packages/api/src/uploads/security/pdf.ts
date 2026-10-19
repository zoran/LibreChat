/** Private process core only; its launcher must isolate credentials, diagnostics and native limits. */
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { PDFDocumentLoadingTask, RenderTask } from 'pdfjs-dist/types/src/display/api';
import type { Canvas } from '@napi-rs/canvas';
import type { SecurityMarkingEvidence, SecurityMarkingPolicy } from './markings';
import type { SecurityInspectionResult } from './inspection';
import { inspectCompleteSecurityEvidence } from './inspection';

type Limits = {
  bytes: number;
  pages: number;
  pagePixels: number;
  totalPixels: number;
  outputBytes: number;
  timeoutMs: number;
};
export const PDF_SECURITY_LIMITS: Readonly<Limits> = Object.freeze({
  bytes: 4 * 1024 * 1024,
  pages: 32,
  pagePixels: 8_000_000,
  totalPixels: 64_000_000,
  outputBytes: 1024 * 1024,
  timeoutMs: 30_000,
});

/** Trusted local composition only. The adapter must honor abort and never retain page pixels. */
export interface PdfSecurityOcr {
  readPage(input: {
    page: number;
    width: number;
    height: number;
    rgba: Uint8ClampedArray;
    signal: AbortSignal;
  }): Promise<{ complete: boolean; readable: boolean; text: string }>;
}
export interface PdfSecurityInput {
  bytes: Uint8Array;
  mediaType: string;
  policy: SecurityMarkingPolicy;
  ocr?: PdfSecurityOcr;
  signal?: AbortSignal;
  /** Trusted composition may reduce these limits, never raise them. */
  limits?: Partial<Limits>;
}
type Reason = Extract<SecurityInspectionResult, { decision: 'uninspectable' }>['reason'];
class PdfInspectionFailure extends Error {
  constructor(readonly reason: Reason) {
    super(reason);
  }
}
function fail(reason: Reason): never {
  throw new PdfInspectionFailure(reason);
}

/**
 * Every supported page is rendered at 144 dpi and inspected by OCR. PDF.js can silently omit
 * malformed content even with stopAtErrors; no PDF clears until diagnostics are independently
 * qualified in the credential-free execution owner. Detected classification markings still reject.
 * No URLs, user paths, shell, normal parser or credential-bearing scanner are used here.
 * Deadlines are cooperative; a separate credential-free process must enforce hard CPU/RSS/time
 * limits and observe process termination before this evidence can become an upload approval.
 */
export async function inspectPdfSecurity(
  input: PdfSecurityInput,
): Promise<SecurityInspectionResult> {
  let loading: PDFDocumentLoadingTask | undefined;
  let rendering: RenderTask | undefined;
  let parserBytes: Uint8Array | undefined;
  let result: SecurityInspectionResult = { decision: 'uninspectable', reason: 'invalid_content' };
  const controller = new AbortController();
  const abort = () => controller.abort(new PdfInspectionFailure('incomplete_coverage'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline = Number.POSITIVE_INFINITY;
  const canvases = new Set<{ canvas: Canvas; context: ReturnType<Canvas['getContext']> }>();
  try {
    const limits: Limits = { ...PDF_SECURITY_LIMITS };
    for (const [key, value] of Object.entries(input.limits ?? {})) {
      if (!(key in limits) || !Number.isSafeInteger(value) || value <= 0) fail('invalid_content');
      const name = key as keyof Limits;
      if (value > PDF_SECURITY_LIMITS[name]) fail('resource_limit');
      limits[name] = value;
    }
    if (
      input.mediaType !== 'application/pdf' ||
      !(input.bytes instanceof Uint8Array) ||
      (typeof SharedArrayBuffer !== 'undefined' && input.bytes.buffer instanceof SharedArrayBuffer)
    )
      fail('invalid_content');
    if (input.bytes.byteLength > limits.bytes) fail('resource_limit');
    if (!/^%PDF-1\.[0-7][\r\n]/u.test(Buffer.from(input.bytes.subarray(0, 10)).toString('ascii')))
      fail('invalid_content');
    const ocr = input.ocr;
    if (!ocr || typeof ocr.readPage !== 'function') fail('incomplete_coverage');
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    deadline = performance.now() + limits.timeoutMs;
    timer = setTimeout(
      () => controller.abort(new PdfInspectionFailure('resource_limit')),
      limits.timeoutMs,
    );
    const check = () => {
      if (performance.now() >= deadline) fail('resource_limit');
      if (controller.signal.aborted) throw controller.signal.reason;
    };
    const wait = async <T>(promise: Promise<T>): Promise<T> => {
      check();
      let rejectAbort: () => void = () => undefined;
      const cancelled = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
      });
      try {
        const value = await Promise.race([promise, cancelled]);
        check();
        return value;
      } finally {
        controller.signal.removeEventListener('abort', rejectAbort);
      }
    };
    check();
    const pdfjs = await wait(import('pdfjs-dist/legacy/build/pdf.mjs'));
    const { createCanvas } = await wait(import('@napi-rs/canvas'));
    let allocatedPixels = 0;
    let auxiliaryFailure = false;
    const pixels = (width: number, height: number) => {
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
        fail('invalid_content');
      const count = width * height;
      if (!Number.isSafeInteger(count) || count > limits.pagePixels) fail('resource_limit');
      allocatedPixels += count;
      if (allocatedPixels > limits.totalPixels) fail('resource_limit');
    };
    class BoundedCanvasFactory {
      create(width: number, height: number) {
        check();
        pixels(width, height);
        const canvas = createCanvas(width, height);
        const item = { canvas, context: canvas.getContext('2d') };
        canvases.add(item);
        return item;
      }

      reset(item: { canvas: Canvas }, width: number, height: number) {
        check();
        pixels(width, height);
        item.canvas.width = width;
        item.canvas.height = height;
      }

      destroy(item: { canvas: Canvas }) {
        item.canvas.width = 0;
        item.canvas.height = 0;
      }
    }
    // Only immutable, installed standard-font assets. CMaps and WASM need separate qualification.
    const fonts = join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts');
    class LocalStandardFonts {
      async fetch({ filename }: { filename: string }) {
        try {
          if (!/^[A-Za-z0-9_-]+\.(?:pfb|ttf)$/u.test(filename)) fail('invalid_content');
          const bytes = await readFile(join(fonts, filename), { signal: controller.signal });
          if (bytes.byteLength > 1024 * 1024) fail('resource_limit');
          return new Uint8Array(bytes);
        } catch (error) {
          auxiliaryFailure = true;
          throw error;
        }
      }
    }
    class UnsupportedAsset {
      async fetch(): Promise<never> {
        auxiliaryFailure = true;
        return fail('incomplete_coverage');
      }
    }
    parserBytes = new Uint8Array(input.bytes);
    loading = pdfjs.getDocument({
      data: parserBytes,
      // Omissions may only warn. The private launcher must observe and contain these diagnostics.
      verbosity: pdfjs.VerbosityLevel.WARNINGS,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      disableAutoFetch: true,
      disableRange: true,
      disableStream: true,
      stopAtErrors: true,
      strictMetadata: true,
      enableXfa: false,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      maxImageSize: limits.pagePixels,
      canvasMaxAreaInBytes: limits.pagePixels * 4,
      CanvasFactory: BoundedCanvasFactory,
      StandardFontDataFactory: LocalStandardFonts,
      CMapReaderFactory: UnsupportedAsset,
      WasmFactory: UnsupportedAsset,
    });
    const document = await wait(loading.promise);
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1) fail('invalid_content');
    if (document.numPages > limits.pages) fail('resource_limit');
    const { info, metadata, metadataInspection } = await wait(document.getMetadata());
    // PDF.js owns the bounded evidence validator. Require its opt-in contract here so a
    // missing/incompatible dependency cannot turn refused catalog metadata into absence.
    if (
      !metadataInspection ||
      metadataInspection.version !== 1 ||
      metadataInspection.scope !== 'catalog-metadata' ||
      metadataInspection.documentComplete !== false
    )
      fail('incomplete_coverage');
    switch (metadataInspection.status) {
      case 'absent':
        if (metadata !== null) fail('incomplete_coverage');
        break;
      case 'validated':
        if (!metadata) fail('incomplete_coverage');
        break;
      case 'refused':
        return fail(
          metadataInspection.reason === 'resource_limit' ? 'resource_limit' : 'incomplete_coverage',
        );
      default:
        fail('incomplete_coverage');
    }
    const properties = info as Record<string, unknown>;
    if (
      properties.EncryptFilterName !== null ||
      properties.IsXFAPresent !== false ||
      properties.IsAcroFormPresent !== false ||
      properties.IsCollectionPresent !== false ||
      properties.IsSignaturesPresent !== false ||
      document.isPureXfa ||
      document.allXfaHtml
    )
      fail('incomplete_coverage');
    if (
      (await wait(document.hasJSActions())) ||
      (await wait(document.getJSActions())) ||
      (await wait(document.getAttachments())) ||
      (await wait(document.getOpenAction())) ||
      (await wait(document.getOutline())) ||
      (await wait(document.getFieldObjects()))
    )
      fail('incomplete_coverage');
    const optional = await wait(document.getOptionalContentConfig({ intent: 'any' }));
    if ([...optional].length || optional.getOrder() !== null) fail('incomplete_coverage');
    const units: SecurityMarkingEvidence['units'][number][] = [];
    let outputBytes = 0;
    const add = (text: unknown, page: number | null) => {
      if (typeof text !== 'string') fail('invalid_content');
      const size = Buffer.byteLength(text, 'utf8');
      if (size > 65_536 || (outputBytes += size) > limits.outputBytes) fail('resource_limit');
      units.push({ part: 1, page, placement: page === null ? 'metadata' : 'body', text });
    };
    add(JSON.stringify(info), null);
    const metadataValues = (value: unknown, depth = 0): void => {
      if (typeof value === 'string') {
        add(value, null);
        return;
      }
      if (value === null || typeof value !== 'object') return;
      if (depth > 4 || Object.keys(value).length > 256) fail('resource_limit');
      for (const item of Object.values(value)) metadataValues(item, depth + 1);
    };
    metadataValues(info);
    if (metadata) add(metadata.getRaw(), null);
    const labels = await wait(document.getPageLabels());
    if (labels) add(JSON.stringify(labels), null);
    const factory = new BoundedCanvasFactory();
    for (let number = 1; number <= document.numPages; number++) {
      const page = await wait(document.getPage(number));
      try {
        if (
          (await wait(page.getAnnotations({ intent: 'any' }))).length ||
          (await wait(page.getJSActions())) ||
          page.isPureXfa
        )
          fail('incomplete_coverage');
        const native = await wait(page.getTextContent({ disableNormalization: true }));
        let text = '';
        for (const item of native.items) {
          if (!('str' in item)) fail('incomplete_coverage');
          text += item.str + (item.hasEOL ? '\n' : ' ');
          if (Buffer.byteLength(text, 'utf8') > 65_536) fail('resource_limit');
        }
        add(text, number);
        const viewport = page.getViewport({ scale: 2 });
        const width = Math.ceil(viewport.width);
        const height = Math.ceil(viewport.height);
        const image = factory.create(width, height);
        let rgba: Uint8ClampedArray | undefined;
        try {
          rendering = page.render({
            canvas: null,
            canvasContext: image.context as unknown as CanvasRenderingContext2D,
            viewport,
            intent: 'print',
            background: 'rgb(255,255,255)',
          });
          await wait(rendering.promise);
          rendering = undefined;
          if (auxiliaryFailure) fail('incomplete_coverage');
          rgba = image.context.getImageData(0, 0, width, height).data;
          const scanned = await wait(
            ocr.readPage({
              page: number,
              width,
              height,
              rgba,
              signal: controller.signal,
            }),
          );
          if (!scanned || scanned.complete !== true || scanned.readable !== true)
            fail('incomplete_coverage');
          add(scanned.text, number);
        } finally {
          rgba?.fill(0);
          factory.destroy(image);
        }
      } finally {
        page.cleanup();
      }
    }
    check();
    if (auxiliaryFailure) fail('incomplete_coverage');
    result = inspectCompleteSecurityEvidence(input.policy, {
      version: 1,
      coverage: { complete: true, pages: document.numPages, parts: 1 },
      units,
    });
    check();
  } catch (error) {
    result = {
      decision: 'uninspectable',
      reason: error instanceof PdfInspectionFailure ? error.reason : 'invalid_content',
    };
  } finally {
    rendering?.cancel();
    try {
      // No positive result leaves before PDF.js has released its document/worker resources.
      await loading?.destroy();
    } catch {
      result = { decision: 'uninspectable', reason: 'invalid_content' };
    }
    // PDF.js may transfer/detach this buffer; native/internal copies require process termination.
    if (parserBytes?.byteLength) parserBytes.fill(0);
    for (const item of canvases) {
      item.canvas.width = 0;
      item.canvas.height = 0;
    }
    if (result.decision === 'clear' && performance.now() >= deadline)
      result = { decision: 'uninspectable', reason: 'resource_limit' };
    else if (controller.signal.aborted && result.decision === 'clear')
      result = { decision: 'uninspectable', reason: 'incomplete_coverage' };
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', abort);
  }
  return result;
}
