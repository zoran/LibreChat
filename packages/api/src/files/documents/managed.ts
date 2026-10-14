import path from 'node:path';
import { JSDOM } from 'jsdom';
import { TextDecoder } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { readSafeZipEntries, ZipBombError } from './zipSafety';

type Limits = {
  inputBytes: number;
  outputBytes: number;
  pages: number;
  archiveEntries: number;
  inflatedBytes: number;
  entryBytes: number;
  wallMs: number;
};
export const MANAGED_DOCUMENT_LIMITS: Readonly<Limits> = Object.freeze({
  inputBytes: 30 * 1024 * 1024,
  outputBytes: 15 * 1024 * 1024,
  pages: 500,
  archiveEntries: 2048,
  inflatedBytes: 100 * 1024 * 1024,
  entryBytes: 25 * 1024 * 1024,
  wallMs: 60_000,
});

export const MANAGED_DOCUMENT_TYPES: readonly [
  'text/plain',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] = Object.freeze([
  'text/plain',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const);

export type DocumentFailureCode =
  | 'unsupported_format'
  | 'resource_limit'
  | 'invalid_document'
  | 'no_text'
  | 'cancelled'
  | 'processing_timeout'
  | 'parser_unavailable';

export class DocumentProcessingError extends Error {
  constructor(readonly code: DocumentFailureCode) {
    super(code);
    this.name = 'DocumentProcessingError';
  }
}

const wordNS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const presentationNS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const drawingNS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const officeRelNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRelNS = 'http://schemas.openxmlformats.org/package/2006/relationships';

function fail(code: DocumentFailureCode): never {
  throw new DocumentProcessingError(code);
}

function decode(data: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return fail('invalid_document');
  }
}

function xml(data: Buffer | undefined): JSDOM {
  if (!data) {
    return fail('invalid_document');
  }
  const value = decode(data);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(value)) {
    return fail('invalid_document');
  }
  try {
    // No resources, script execution, external URLs or custom entity resolver.
    return new JSDOM(value, { contentType: 'application/xml' });
  } catch {
    return fail('invalid_document');
  }
}

function textCollector(maxBytes: number) {
  const chunks: string[] = [];
  let bytes = 0;
  return {
    add(value: string) {
      bytes += Buffer.byteLength(value, 'utf8');
      if (bytes > maxBytes) {
        fail('resource_limit');
      }
      chunks.push(value);
    },
    finish() {
      const text = chunks.join('');
      if (!text.trim()) {
        fail('no_text');
      }
      return { text, bytes };
    },
  };
}

/** Run only in the isolated parser child. Limits can only be lowered for fixtures. */
export async function extractManagedDocument(input: {
  filePath: string;
  mediaType: string;
  limits?: Partial<Limits>;
}): Promise<{ text: string; bytes: number }> {
  const limits = { ...MANAGED_DOCUMENT_LIMITS, ...input.limits };
  for (const key of Object.keys(limits) as Array<keyof Limits>) {
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < 1 ||
      limits[key] > MANAGED_DOCUMENT_LIMITS[key]
    ) {
      fail('resource_limit');
    }
  }
  if (!MANAGED_DOCUMENT_TYPES.some((type) => type === input.mediaType)) {
    fail('unsupported_format');
  }
  const info = await stat(input.filePath);
  if (!info.isFile() || info.size < 1 || info.size > limits.inputBytes) {
    fail('resource_limit');
  }
  const data = await readFile(input.filePath);
  if (data.length !== info.size || data.length > limits.inputBytes) {
    fail('resource_limit');
  }
  const output = textCollector(limits.outputBytes);
  if (input.mediaType === 'text/plain') {
    output.add(decode(data));
    return output.finish();
  }
  if (input.mediaType === 'application/pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({
      data: new Uint8Array(data),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      disableAutoFetch: true,
      stopAtErrors: true,
    });
    try {
      const pdf = await loading.promise;
      if (pdf.numPages > limits.pages) {
        fail('resource_limit');
      }
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        try {
          const content = await page.getTextContent();
          for (const item of content.items) {
            if ('str' in item) {
              const text = item as TextItem;
              output.add(text.str);
              output.add(text.hasEOL ? '\n' : ' ');
            }
          }
          output.add('\n');
        } finally {
          page.cleanup();
        }
      }
    } finally {
      await loading.destroy();
    }
    return output.finish();
  }

  let parts: Map<string, Buffer>;
  try {
    parts = await readSafeZipEntries(data, {
      maxTotalBytes: limits.inflatedBytes,
      maxEntryBytes: limits.entryBytes,
      maxEntries: limits.archiveEntries,
      select: (name) => name.endsWith('.xml') || name.endsWith('.rels'),
    });
  } catch (error) {
    return fail(error instanceof ZipBombError ? 'resource_limit' : 'invalid_document');
  }
  // All relationships are inert; explicitly refuse external relationships in extraction inputs.
  // Ordinary hyperlinks may be present: their visible text is extracted without following them.
  if (input.mediaType === MANAGED_DOCUMENT_TYPES[2]) {
    const document = xml(parts.get('word/document.xml'));
    try {
      // DOCX has no trustworthy rendered page count. Bound explicit page boundaries;
      // ZIP/output/wall/cgroup bounds also apply to unpaginated documents.
      const doc = document.window.document;
      const explicitBreaks = Array.from(doc.getElementsByTagNameNS(wordNS, 'br')).filter(
        (node) => node.getAttributeNS(wordNS, 'type') === 'page',
      ).length;
      if (explicitBreaks + 1 > limits.pages) {
        fail('resource_limit');
      }
    } finally {
      document.window.close();
    }
    const { extractRawText } = await import('mammoth');
    const result = await extractRawText({ buffer: data });
    output.add(result.value);
    return output.finish();
  }

  const presentation = xml(parts.get('ppt/presentation.xml'));
  const relationships = xml(parts.get('ppt/_rels/presentation.xml.rels'));
  try {
    const targets = new Map<string, string>();
    for (const relationship of Array.from(
      relationships.window.document.getElementsByTagNameNS(packageRelNS, 'Relationship'),
    )) {
      if (relationship.getAttribute('Type') !== `${officeRelNS}/slide`) {
        continue;
      }
      if (relationship.getAttribute('TargetMode') === 'External') {
        fail('invalid_document');
      }
      const id = relationship.getAttribute('Id');
      const target = relationship.getAttribute('Target');
      if (!id || !target || /[\\?#:%]/.test(target) || targets.has(id)) {
        fail('invalid_document');
      }
      const resolved = target.startsWith('/')
        ? target.slice(1)
        : path.posix.normalize(`ppt/${target}`);
      if (!resolved.startsWith('ppt/slides/') || !resolved.endsWith('.xml')) {
        fail('invalid_document');
      }
      targets.set(id, resolved);
    }
    const slides = Array.from(
      presentation.window.document.getElementsByTagNameNS(presentationNS, 'sldId'),
    );
    if (slides.length > limits.pages) {
      fail('resource_limit');
    }
    const used = new Set<string>();
    for (const slideRef of slides) {
      const id = slideRef.getAttributeNS(officeRelNS, 'id');
      const target = id ? targets.get(id) : undefined;
      if (!target || used.has(target)) {
        fail('invalid_document');
      }
      used.add(target);
      const slide = xml(parts.get(target));
      try {
        for (const paragraph of Array.from(
          slide.window.document.getElementsByTagNameNS(drawingNS, 'p'),
        )) {
          for (const run of Array.from(paragraph.getElementsByTagNameNS(drawingNS, 't'))) {
            output.add(run.textContent ?? '');
          }
          output.add('\n');
        }
        output.add('\n');
      } finally {
        slide.window.close();
      }
    }
  } finally {
    presentation.window.close();
    relationships.window.close();
  }
  return output.finish();
}
