/** Public personal-library metadata and input boundary; native File owns access and retention. */
import { FileContext, FileSources } from './types/files';
import type { TFile } from './types/files';

export const FILE_LIBRARY_DEFAULT_LIMIT = 25;
export const FILE_LIBRARY_MAX_LIMIT = 50;
export const FILE_LIBRARY_MAX_TAGS = 20;
export const FILE_LIBRARY_MAX_TAG_LENGTH = 48;
export const FILE_LIBRARY_MAX_TAG_BYTES = 2048;
export const FILE_LIBRARY_MAX_SEARCH_LENGTH = 200;

/** Organization only: an archive marker never changes a File's access or expiry. */
export type FileLibraryMetadata = {
  tags: string[];
  archivedAt: string | null;
  revision: number;
};

/** Explicit public projection; adding a native File field never publishes it implicitly. */
export const FILE_LIBRARY_ITEM_FIELDS = [
  'file_id',
  'filename',
  'type',
  'bytes',
  'source',
  'context',
  'createdAt',
  'updatedAt',
  'expiredAt',
  'status',
  'embedded',
  'filepath',
  'user',
  'object',
  'usage',
  'llmDeliveryPath',
] as const satisfies readonly (keyof TFile)[];

export type FileLibraryItem = Pick<TFile, (typeof FILE_LIBRARY_ITEM_FIELDS)[number]> & {
  library: FileLibraryMetadata;
};

export type FileLibraryQuery = {
  limit?: number;
  cursor?: string;
  search?: string;
  tag?: string;
  type?: string;
  archive?: 'active' | 'archived' | 'all';
  projectId?: string;
};

export type FileLibraryResolvedQuery = FileLibraryQuery & {
  limit: number;
  archive: NonNullable<FileLibraryQuery['archive']>;
};

export type FileLibraryPage = { files: FileLibraryItem[]; nextCursor: string | null };

/** CAS protects concurrent edits; only explicitly supplied organization fields may change. */
export type FileLibraryUpdate = {
  expectedRevision: number;
  tags?: string[];
  archived?: boolean;
};

export type FileLibraryUpdateResult =
  | { kind: 'updated'; library: FileLibraryMetadata }
  | { kind: 'conflict' }
  | { kind: 'unavailable' };

function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().normalize('NFC');
  const characters = Array.from(normalized);
  if (
    characters.length > maxLength ||
    characters.some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 32 || (point >= 127 && point <= 159) || (point >= 0xd800 && point <= 0xdfff);
    })
  )
    return null;
  return normalized;
}

function tags(value: unknown): string[] | null {
  const values = array(value, FILE_LIBRARY_MAX_TAGS);
  if (!values) return null;
  const result: string[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const value of values) {
    const label = text(value, FILE_LIBRARY_MAX_TAG_LENGTH);
    if (!label) return null;
    const key = label.toLowerCase().normalize('NFC');
    if (seen.has(key)) continue;
    bytes += new TextEncoder().encode(label).length;
    if (bytes > FILE_LIBRARY_MAX_TAG_BYTES) return null;
    seen.add(key);
    result.push(label);
  }
  return result;
}

function array(value: unknown, maxLength: number): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maxLength) return null;
  if (Reflect.ownKeys(value).length !== length + 1) return null;
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    result.push(descriptor.value);
  }
  return result;
}

function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function objectId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 24 && !/[^a-fA-F0-9]/.test(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 27 && new Date(value).toISOString() === value;
}

/** Accept JSON/HTTP scalars only; query operators, repeated values and caller identity fail closed. */
export function readFileLibraryQuery(value: unknown): FileLibraryResolvedQuery | null {
  try {
    const input = record(value, [
      'limit',
      'cursor',
      'search',
      'tag',
      'type',
      'archive',
      'projectId',
    ]);
    if (!input) return null;
    let limit: unknown = 'limit' in input ? input.limit : FILE_LIBRARY_DEFAULT_LIMIT;
    if (typeof limit === 'string' && String(Number(limit)) === limit) limit = Number(limit);
    if (
      typeof limit !== 'number' ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > FILE_LIBRARY_MAX_LIMIT
    )
      return null;
    const archive = 'archive' in input ? input.archive : 'active';
    if (archive !== 'active' && archive !== 'archived' && archive !== 'all') return null;
    const query: FileLibraryResolvedQuery = { limit, archive };
    for (const key of ['cursor', 'projectId'] as const) {
      if (!(key in input)) continue;
      const id = input[key];
      if (!objectId(id)) return null;
      query[key] = id.toLowerCase();
    }
    if ('search' in input) {
      const search = text(input.search, FILE_LIBRARY_MAX_SEARCH_LENGTH);
      if (search === null) return null;
      if (search) query.search = search;
    }
    if ('tag' in input) {
      const tag = text(input.tag, FILE_LIBRARY_MAX_TAG_LENGTH);
      if (!tag) return null;
      query.tag = tag;
    }
    if ('type' in input) {
      if (
        typeof input.type !== 'string' ||
        input.type.length > 128 ||
        input.type.match(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/)?.[0] !== input.type
      )
        return null;
      query.type = input.type;
    }
    return query;
  } catch {
    return null;
  }
}

/** Capture a detached update before asynchronous work; absent fields are never inferred changes. */
export function readFileLibraryUpdate(value: unknown): FileLibraryUpdate | null {
  try {
    const input = record(value, ['expectedRevision', 'tags', 'archived']);
    if (
      !input ||
      !revision(input.expectedRevision) ||
      (!('tags' in input) && !('archived' in input))
    )
      return null;
    const update: FileLibraryUpdate = { expectedRevision: input.expectedRevision };
    if ('tags' in input) {
      const normalized = tags(input.tags);
      if (!normalized) return null;
      update.tags = normalized;
    }
    if ('archived' in input) {
      if (typeof input.archived !== 'boolean') return null;
      update.archived = input.archived;
    }
    return update;
  } catch {
    return null;
  }
}

/** No legacy defaults here: only the File owner can distinguish absent from corrupt metadata. */
export function readFileLibraryMetadata(value: unknown): FileLibraryMetadata | null {
  try {
    const input = record(value, ['tags', 'archivedAt', 'revision']);
    if (!input || !revision(input.revision)) return null;
    const normalized = tags(input.tags);
    if (!normalized) return null;
    const archivedAt = input.archivedAt;
    if (archivedAt !== null && !timestamp(archivedAt)) return null;
    return { tags: normalized, archivedAt, revision: input.revision };
  } catch {
    return null;
  }
}

/** Decode an already authorized public projection; the HTTP owner supplies its safe download URL. */
export function readFileLibraryItem(value: unknown): FileLibraryItem | null {
  try {
    const input = record(value, [...FILE_LIBRARY_ITEM_FIELDS, 'library']);
    if (
      !input ||
      typeof input.file_id !== 'string' ||
      !input.file_id ||
      typeof input.filename !== 'string' ||
      !input.filename ||
      typeof input.type !== 'string' ||
      !input.type ||
      !revision(input.bytes) ||
      typeof input.embedded !== 'boolean' ||
      typeof input.filepath !== 'string' ||
      !input.filepath ||
      typeof input.user !== 'string' ||
      !input.user ||
      input.object !== 'file' ||
      !revision(input.usage)
    )
      return null;
    const library = readFileLibraryMetadata(input.library);
    if (!library) return null;
    const item: FileLibraryItem = {
      file_id: input.file_id,
      filename: input.filename,
      type: input.type,
      bytes: input.bytes,
      embedded: input.embedded,
      filepath: input.filepath,
      user: input.user,
      object: input.object,
      usage: input.usage,
      library,
    };
    for (const key of ['createdAt', 'updatedAt', 'expiredAt'] as const) {
      if (!(key in input)) continue;
      const value = input[key];
      if (key === 'expiredAt' && value === null) item.expiredAt = null;
      else if (timestamp(value)) item[key] = value;
      else return null;
    }
    if ('source' in input) {
      const source = Object.values(FileSources).find((source) => source === input.source);
      if (!source) return null;
      item.source = source;
    }
    if ('context' in input) {
      const context = Object.values(FileContext).find((context) => context === input.context);
      if (!context) return null;
      item.context = context;
    }
    if ('status' in input) {
      if (input.status !== 'pending' && input.status !== 'ready' && input.status !== 'failed')
        return null;
      item.status = input.status;
    }
    if ('llmDeliveryPath' in input) {
      if (
        input.llmDeliveryPath !== 'provider' &&
        input.llmDeliveryPath !== 'text' &&
        input.llmDeliveryPath !== 'none'
      )
        return null;
      item.llmDeliveryPath = input.llmDeliveryPath;
    }
    return item;
  } catch {
    return null;
  }
}

/** A bounded response never silently accepts private fields or corrupt items. */
export function readFileLibraryPage(value: unknown): FileLibraryPage | null {
  try {
    const input = record(value, ['files', 'nextCursor']);
    if (!input || (input.nextCursor !== null && !objectId(input.nextCursor))) return null;
    const values = array(input.files, FILE_LIBRARY_MAX_LIMIT);
    if (!values) return null;
    const files: FileLibraryItem[] = [];
    const ids = new Set<string>();
    for (const value of values) {
      const file = readFileLibraryItem(value);
      if (!file || ids.has(file.file_id)) return null;
      ids.add(file.file_id);
      files.push(file);
    }
    return { files, nextCursor: input.nextCursor?.toLowerCase() ?? null };
  } catch {
    return null;
  }
}
