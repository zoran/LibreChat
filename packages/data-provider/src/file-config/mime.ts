/** mime.ts owns finite MIME capability and browser accept projection. */
import type { RegexLike } from '../types/files';
import { fullMimeTypesList, supportedMimeTypes } from './catalog';
import { isPermissiveMimeConfig } from './core';

/** The kind of content a provider upload path can actually send to the model. */
export type MimeUploadCategory = 'image' | 'document' | 'audio' | 'video';

/** Describes what an upload path can send, used to scope a configured allowlist to selectable files. */
export interface MimeUploadCapability {
  /** Content categories the path forwards to the model. */
  categories: ReadonlyArray<MimeUploadCategory>;
  /** When `document` is permitted, restrict document types to this set (e.g. Bedrock formats); default: all. */
  documentMimeTypes?: readonly string[];
}

/** Media categories that collapse to a wildcard `accept` token when any member type is allowed. */
const mimeAcceptCategories: ReadonlyArray<{
  category: Exclude<MimeUploadCategory, 'document'>;
  token: string;
  samples: readonly string[];
  extras?: readonly string[];
}> = [
  {
    /** Mirrors `imageMimeTypes` (+ the code-interpreter svg variants) so every accepted type is known. */
    category: 'image',
    token: 'image/*',
    samples: [
      'image/jpeg',
      'image/gif',
      'image/png',
      'image/webp',
      'image/heic',
      'image/heif',
      'image/svg',
      'image/svg+xml',
    ],
    extras: ['.heif', '.heic'],
  },
  {
    /** Mirrors `audioMimeTypes`. */
    category: 'audio',
    token: 'audio/*',
    samples: [
      'audio/mp3',
      'audio/mpeg',
      'audio/mpeg3',
      'audio/wav',
      'audio/wave',
      'audio/x-wav',
      'audio/ogg',
      'audio/vorbis',
      'audio/mp4',
      'audio/m4a',
      'audio/x-m4a',
      'audio/flac',
      'audio/x-flac',
      'audio/webm',
      'audio/aac',
      'audio/wma',
      'audio/opus',
    ],
  },
  {
    /** Mirrors `videoMimeTypes`. */
    category: 'video',
    token: 'video/*',
    samples: [
      'video/mp4',
      'video/avi',
      'video/mov',
      'video/wmv',
      'video/flv',
      'video/webm',
      'video/mkv',
      'video/m4v',
      'video/3gp',
      'video/ogv',
    ],
  },
];

/** Document/text MIME types paired with the extension(s) browsers filter on in the file picker. */
const documentMimeExtensions: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['application/pdf', ['.pdf']],
  ['application/msword', ['.doc']],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ['.docx']],
  ['application/vnd.ms-excel', ['.xls']],
  ['application/msexcel', ['.xls']],
  ['application/x-msexcel', ['.xls']],
  ['application/x-ms-excel', ['.xls']],
  ['application/x-excel', ['.xls']],
  ['application/x-dos_ms_excel', ['.xls']],
  ['application/xls', ['.xls']],
  ['application/x-xls', ['.xls']],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ['.xlsx']],
  ['application/vnd.ms-powerpoint', ['.ppt']],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', ['.pptx']],
  ['application/vnd.openxmlformats-officedocument.presentationml.template', ['.potx']],
  ['application/vnd.oasis.opendocument.text', ['.odt']],
  ['application/vnd.oasis.opendocument.spreadsheet', ['.ods']],
  ['application/vnd.oasis.opendocument.presentation', ['.odp']],
  ['application/vnd.oasis.opendocument.graphics', ['.odg']],
  ['application/rtf', ['.rtf']],
  ['application/json', ['.json']],
  ['application/xml', ['.xml']],
  ['application/yaml', ['.yaml', '.yml']],
  ['application/zip', ['.zip']],
  ['application/x-zip-compressed', ['.zip']],
  ['application/epub+zip', ['.epub']],
  ['application/x-parquet', ['.parquet']],
  ['application/vnd.apache.parquet', ['.parquet']],
  ['text/csv', ['.csv']],
  ['application/csv', ['.csv']],
  ['text/tab-separated-values', ['.tsv']],
  ['text/plain', ['.txt']],
  ['text/markdown', ['.md']],
  ['text/html', ['.html', '.htm']],
  ['text/calendar', ['.ics']],
  ['message/rfc822', ['.eml']],
];

/** Preferred extension for a known document MIME type, including its leading dot. */
export function getDocumentFileExtension(mimeType?: string): string | undefined {
  const normalized = mimeType?.split(';', 1)[0].trim().toLowerCase();
  const canonical = normalized === 'text/comma-separated-values' ? 'text/csv' : normalized;
  return documentMimeExtensions.find(([type]) => type === canonical)?.[1][0];
}

const documentMimeSet = new Set(documentMimeExtensions.map(([mimeType]) => mimeType));

/** Every MIME type LibreChat may accept, used to detect patterns that reach beyond the representable set. */
const knownMimeUniverse: readonly string[] = Array.from(
  new Set<string>([
    ...fullMimeTypesList,
    ...documentMimeExtensions.map(([mimeType]) => mimeType),
    ...mimeAcceptCategories.flatMap((category) => category.samples),
  ]),
);

const categoryOf = (mimeType: string): MimeUploadCategory => {
  if (mimeType.startsWith('image/')) {
    return 'image';
  }
  if (mimeType.startsWith('audio/')) {
    return 'audio';
  }
  if (mimeType.startsWith('video/')) {
    return 'video';
  }
  return 'document';
};

/** Media types are covered by their `<cat>/*` wildcard token; document types need an explicit entry. */
const isRepresentable = (mimeType: string): boolean =>
  categoryOf(mimeType) !== 'document' || documentMimeSet.has(mimeType);

/**
 * Translates a finite MIME allowlist into a file-input `accept` string, intersected with what the
 * provider upload path can actually send. Returns `undefined` (keep the provider filter) when a
 * configured pattern matches a supported, path-handleable type that cannot be represented, so the
 * picker never hides a file the path would have accepted.
 */
const buildMimeAccept = (
  types: RegexLike[],
  { categories, documentMimeTypes }: MimeUploadCapability,
): string | undefined => {
  const permittedSet = new Set<MimeUploadCategory>(categories);
  const documentAllowSet = documentMimeTypes ? new Set(documentMimeTypes) : null;
  const emittedMedia = new Set<MimeUploadCategory>();
  const emittedDocuments = new Set<string>();

  /** A pattern matching nothing known may still accept a supported type we can't represent; fall back. */
  const everyPatternKnown = types.every((regex) =>
    knownMimeUniverse.some((mimeType) => regex.test(mimeType)),
  );
  if (!everyPatternKnown) {
    return undefined;
  }

  for (const regex of types) {
    for (const mimeType of knownMimeUniverse) {
      if (!regex.test(mimeType)) {
        continue;
      }
      const category = categoryOf(mimeType);
      if (!permittedSet.has(category)) {
        continue;
      }
      /** The path handles documents but drops this specific type (e.g. Bedrock ignores pptx/ODF). */
      if (category === 'document' && documentAllowSet && !documentAllowSet.has(mimeType)) {
        continue;
      }
      if (!isRepresentable(mimeType)) {
        return undefined;
      }
      if (category === 'document') {
        emittedDocuments.add(mimeType);
      } else {
        emittedMedia.add(category);
      }
    }
  }

  const tokens: string[] = [];
  const seen = new Set<string>();
  const push = (token: string): void => {
    if (!seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  };

  for (const category of mimeAcceptCategories) {
    if (emittedMedia.has(category.category)) {
      push(category.token);
      category.extras?.forEach(push);
    }
  }

  for (const [mimeType, extensions] of documentMimeExtensions) {
    if (emittedDocuments.has(mimeType)) {
      extensions.forEach(push);
      push(mimeType);
    }
  }

  return tokens.length > 0 ? tokens.join(',') : undefined;
};

/**
 * Resolves the file-input `accept` value for a configured `supportedMimeTypes` allowlist, scoped to
 * what the current upload path (`capability`) can send to the model.
 * - `undefined` for the built-in default or a config that can't be represented safely, so callers
 *   keep their provider-specific filter.
 * - `''` for permissive configs (e.g. `.*`), leaving the picker unrestricted.
 * - a translated `accept` string for a recognized finite allowlist (images, PDFs, Office docs, etc.).
 *
 * The picker `accept` is a UX convenience, not a security boundary: the backend still enforces
 * `supportedMimeTypes` on upload.
 */
export const getConfiguredMimeAccept = (
  types: RegexLike[] | undefined,
  capability: MimeUploadCapability,
): string | undefined => {
  /** Referential identity with the built-in list signals an unconfigured endpoint (keep provider filter). */
  if (!types || types.length === 0 || types === supportedMimeTypes) {
    return undefined;
  }
  if (isPermissiveMimeConfig(types)) {
    return '';
  }
  return buildMimeAccept(types, capability);
};
