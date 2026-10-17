import path from 'node:path';
import { JSDOM } from 'jsdom';
import { TextDecoder } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { readManagedDocumentResult } from 'librechat-data-provider';
import type { ManagedDocumentResult } from 'librechat-data-provider';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import {
  ManagedStructure,
  plainParagraphs,
  wordStructure,
  slideStructure,
  wordNS,
} from './managedStructure';
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

const presentationNS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
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
  let length = 0;
  return {
    get length() {
      return length;
    },
    add(value: string) {
      bytes += Buffer.byteLength(value, 'utf8');
      if (bytes > maxBytes) {
        fail('resource_limit');
      }
      chunks.push(value);
      length += value.length;
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

/** Isolated extraction only, never security approval. Limits can only be lowered for fixtures. */
export async function extractManagedDocument(input: {
  filePath: string;
  mediaType: string;
  limits?: Partial<Limits>;
}): Promise<ManagedDocumentResult & { bytes: number }> {
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
  const structure = new ManagedStructure(data, input.mediaType, () => fail('resource_limit'));
  const finish = () => {
    const result = output.finish();
    const value = structure.finish();
    if (!readManagedDocumentResult({ text: result.text, structure: value }))
      fail('invalid_document');
    return { ...result, structure: value };
  };
  if (input.mediaType === 'text/plain') {
    output.add(decode(data));
    plainParagraphs(output.finish().text, structure);
    return finish();
  }
  if (input.mediaType === 'application/pdf') {
    structure.warn('layout_unavailable');
    structure.warn('visual_content_not_extracted');
    structure.warn('table_structure_unavailable');
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
        structure.value.pages.push({ number: pageNumber, kind: 'page' });
        const page = await pdf.getPage(pageNumber);
        try {
          const content = await page.getTextContent();
          const start = output.length;
          let hasText = false;
          for (const item of content.items) {
            if ('str' in item) {
              const text = item as TextItem;
              output.add(text.str);
              hasText ||= text.str.trim().length > 0;
              output.add(text.hasEOL ? '\n' : ' ');
            }
          }
          if (hasText) structure.add('paragraph', start, output.length, pageNumber);
          output.add('\n');
        } finally {
          page.cleanup();
        }
      }
    } finally {
      await loading.destroy();
    }
    return finish();
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
  // Relationships are inert. Visible hyperlinks are text only; external slide targets are refused.
  structure.warn('layout_unavailable');
  if (input.mediaType === MANAGED_DOCUMENT_TYPES[2]) {
    const document = xml(parts.get('word/document.xml'));
    let styles: JSDOM | undefined;
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
      if (parts.has('word/styles.xml')) styles = xml(parts.get('word/styles.xml'));
      const { extractRawText } = await import('mammoth');
      const result = await extractRawText({ buffer: data });
      output.add(result.value);
      if (
        result.messages.length ||
        Array.from(parts.keys()).some((name) =>
          /^word\/(?:header|footer|footnotes|endnotes|comments).*\.xml$/.test(name),
        )
      ) {
        structure.warn('unsupported_content');
      }
      wordStructure(doc, styles?.window.document, result.value, structure);
    } finally {
      document.window.close();
      styles?.window.close();
    }
    return finish();
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
      const page = used.size;
      structure.value.pages.push({ number: page, kind: 'slide' });
      const slide = xml(parts.get(target));
      try {
        slideStructure(slide.window.document, page, structure, output);
        output.add('\n');
      } finally {
        slide.window.close();
      }
    }
  } finally {
    presentation.window.close();
    relationships.window.close();
  }
  if (Array.from(parts.keys()).some((name) => /^ppt\/(?:notesSlides|slideMasters)\//.test(name))) {
    structure.warn('unsupported_content');
  }
  return finish();
}
