/** Untrusted HTTP/JSON and stored metadata share one bounded library contract. */
import {
  readFileLibraryItem,
  readFileLibraryMetadata,
  readFileLibraryPage,
  readFileLibraryQuery,
  readFileLibraryUpdate,
} from './file-library';
import { FileContext, FileSources } from './types/files';
import type { FileLibraryItem } from './file-library';

const id = '0123456789abcdef01234567';
const archivedAt = '2026-10-17T20:00:00.000Z';
const metadata = () => ({ tags: ['Planung'], archivedAt: null, revision: 0 });
const item = (): FileLibraryItem => ({
  file_id: 'file-1',
  filename: 'Planung.pdf',
  type: 'application/pdf',
  bytes: 1234,
  source: FileSources.local,
  context: FileContext.message_attachment,
  createdAt: archivedAt,
  updatedAt: archivedAt,
  expiredAt: null,
  status: 'ready',
  embedded: false,
  filepath: '/api/files/download/user/file-1',
  user: 'user',
  object: 'file',
  usage: 0,
  llmDeliveryPath: 'text',
  library: metadata(),
});

describe('library request boundary', () => {
  test('normalizes HTTP scalars without taking caller identity or changing query meaning', () => {
    expect(readFileLibraryQuery({})).toEqual({ limit: 25, archive: 'active' });
    expect(readFileLibraryQuery(Object.assign(Object.create(null), { limit: '50' }))).toEqual({
      limit: 50,
      archive: 'active',
    });
    expect(
      readFileLibraryQuery({
        limit: '1',
        cursor: id.toUpperCase(),
        search: '  Cafe\u0301 [2026].*  ',
        tag: '  U\u0308bersicht ',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        archive: 'all',
        projectId: id.toUpperCase(),
      }),
    ).toEqual({
      limit: 1,
      cursor: id,
      search: 'Café [2026].*',
      tag: 'Übersicht',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      archive: 'all',
      projectId: id,
    });
    expect(readFileLibraryQuery({ search: '  ' })).toEqual({ limit: 25, archive: 'active' });
    expect(readFileLibraryQuery({ search: '😀'.repeat(200) })?.search).toHaveLength(400);
  });

  test.each([
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
    { limit: NaN },
    { limit: Infinity },
    { limit: true },
    { limit: null },
    { limit: undefined },
    { limit: '' },
    { limit: '01' },
    { limit: '+1' },
    { limit: '1e1' },
    { limit: '0x10' },
    { limit: '1\n' },
    { limit: ['25'] },
    { limit: { $gt: 1 } },
    { cursor: `${id}\n` },
    { cursor: 'g'.repeat(24) },
    { cursor: { $lt: id } },
    { projectId: 'project' },
    { projectId: null },
    { search: 'a'.repeat(201) },
    { search: ['one', 'two'] },
    { search: 'a\u0000b' },
    { search: '\ud800' },
    { tag: '' },
    { tag: 'a'.repeat(49) },
    { tag: ['a'] },
    { type: 'application/pdf\n' },
    { type: 'text/*' },
    { type: 'text/plain; charset=utf-8' },
    { type: `text/${'a'.repeat(124)}` },
    { archive: 'false' },
    { archive: false },
    { owner: 'other' },
    { user: 'other' },
    { tenantId: 'other' },
    { offset: 100 },
    { $where: 'true' },
  ])('rejects malformed query %j', (query) => {
    expect(readFileLibraryQuery(query)).toBeNull();
  });

  test('captures an explicit CAS update, preserving first tag labels and absence of other changes', () => {
    const input = {
      expectedRevision: 4,
      tags: ['  U\u0308bersicht ', 'übersicht', 'Daten', ' DATEN '],
    };
    const update = readFileLibraryUpdate(input);
    expect(update).toEqual({ expectedRevision: 4, tags: ['Übersicht', 'Daten'] });
    input.expectedRevision = 8;
    input.tags[0] = 'changed';
    expect(update).toEqual({ expectedRevision: 4, tags: ['Übersicht', 'Daten'] });
    expect(readFileLibraryUpdate({ expectedRevision: 0, tags: [], archived: false })).toEqual({
      expectedRevision: 0,
      tags: [],
      archived: false,
    });
    expect(
      readFileLibraryUpdate({ expectedRevision: Number.MAX_SAFE_INTEGER, archived: true }),
    ).toEqual({
      expectedRevision: Number.MAX_SAFE_INTEGER,
      archived: true,
    });
  });

  test.each([
    {},
    { expectedRevision: 0 },
    { expectedRevision: '0', tags: [] },
    { expectedRevision: -1, tags: [] },
    { expectedRevision: 0.5, tags: [] },
    { expectedRevision: Infinity, tags: [] },
    { expectedRevision: Number.MAX_SAFE_INTEGER + 1, tags: [] },
    { expectedRevision: 0, tags: null },
    { expectedRevision: 0, tags: [1] },
    { expectedRevision: 0, tags: [' '] },
    { expectedRevision: 0, tags: ['one\ntwo'] },
    { expectedRevision: 0, tags: ['\udfff'] },
    { expectedRevision: 0, tags: ['a'.repeat(49)] },
    { expectedRevision: 0, tags: ['😀'.repeat(49)] },
    { expectedRevision: 0, tags: Array.from({ length: 21 }, (_, i) => String(i)) },
    { expectedRevision: 0, tags: undefined },
    { expectedRevision: 0, archived: 'true' },
    { expectedRevision: 0, archived: null },
    { expectedRevision: 0, archived: undefined },
    { expectedRevision: 0, archivedAt },
    { expectedRevision: 0, tags: [], expiresAt: archivedAt },
    { expectedRevision: 0, archived: true, user: 'other' },
    { expectedRevision: 0, archived: true, content: 'replacement' },
  ])('rejects malformed update %j', (update) => {
    expect(readFileLibraryUpdate(update)).toBeNull();
  });

  test('enforces codepoint and aggregate UTF8 limits after NFC normalization', () => {
    expect(readFileLibraryUpdate({ expectedRevision: 0, tags: ['😀'.repeat(48)] })?.tags).toEqual([
      '😀'.repeat(48),
    ]);
    expect(
      readFileLibraryUpdate({ expectedRevision: 0, tags: ['e\u0301'.repeat(48)] })?.tags,
    ).toEqual(['é'.repeat(48)]);
    const tags = Array.from({ length: 10 }, (_, i) => `${'😀'.repeat(47)}${i}`);
    tags.push(`${'😀'.repeat(39)}ab`);
    expect(tags.reduce((bytes, tag) => bytes + new TextEncoder().encode(tag).length, 0)).toBe(2048);
    expect(readFileLibraryUpdate({ expectedRevision: 0, tags })?.tags).toEqual(tags);
    tags[10] += 'c';
    expect(readFileLibraryUpdate({ expectedRevision: 0, tags })).toBeNull();
  });

  test('rejects sparse, decorated, subclassed and accessor tag arrays without invoking getters', () => {
    const getter = jest.fn(() => 'hidden');
    const accessor = Object.defineProperty([], '0', { get: getter, enumerable: true });
    const decorated = Object.assign(['tag'], { approved: true });
    class Tags extends Array<string> {}
    for (const tags of [new Array(1), accessor, decorated, new Tags('tag')]) {
      expect(readFileLibraryUpdate({ expectedRevision: 0, tags })).toBeNull();
    }
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('library public response boundary', () => {
  test('preserves an empty intermediate page after current authorization hides its candidates', () => {
    expect(readFileLibraryPage({ files: [], nextCursor: id })).toEqual({
      files: [],
      nextCursor: id,
    });
  });

  test('round-trips the serialized public page and detaches nested mutable metadata', () => {
    const wire = JSON.parse(JSON.stringify({ files: [item()], nextCursor: id }));
    const page = readFileLibraryPage(wire);
    expect(page).toEqual(wire);
    wire.files[0].library.tags[0] = 'changed';
    wire.files[0].library.revision = 10;
    wire.files[0].filename = 'changed';
    expect(page?.files[0]).toEqual(item());
    expect(readFileLibraryPage({ files: [], nextCursor: null })).toEqual({
      files: [],
      nextCursor: null,
    });
  });

  test('requires explicit complete metadata and validates canonical archive timestamps', () => {
    expect(readFileLibraryMetadata({ ...metadata(), archivedAt })).toEqual({
      ...metadata(),
      archivedAt,
    });
    for (const value of [
      undefined,
      null,
      {},
      { tags: [], revision: 0 },
      { ...metadata(), revision: '0' },
      { ...metadata(), revision: -1 },
      { ...metadata(), archivedAt: new Date(archivedAt) },
      { ...metadata(), archivedAt: '2026-02-30T20:00:00.000Z' },
      { ...metadata(), archivedAt: '2026-10-17' },
      { ...metadata(), archivedAt: 'invalid' },
      { ...metadata(), approved: true },
    ]) {
      expect(readFileLibraryMetadata(value)).toBeNull();
    }
  });

  test.each([
    'text',
    'preview',
    'documentStructure',
    'storageKey',
    'storageRegion',
    'tenantId',
    'metadata',
    'approval',
    'retentionAcceptedAt',
    '_id',
  ])('rejects a leaked private/native field %s instead of silently dropping it', (field) => {
    expect(
      readFileLibraryPage({ files: [{ ...item(), [field]: 'private' }], nextCursor: null }),
    ).toBeNull();
  });

  test.each([
    { bytes: -1 },
    { bytes: 1.5 },
    { usage: '1' },
    { file_id: '' },
    { embedded: undefined },
    { object: 'secret' },
    { source: 'unexpected' },
    { context: 'unexpected' },
    { status: 'approved' },
    { llmDeliveryPath: 'unsafe' },
    { createdAt: 'invalid' },
    { expiredAt: new Date() },
    { library: undefined },
  ])('rejects malformed public file %j', (patch) => {
    expect(readFileLibraryItem({ ...item(), ...patch })).toBeNull();
  });

  test('rejects corrupt, duplicate, unbounded or inconsistent pagination responses', () => {
    for (const page of [
      { files: [item()] },
      { files: [item()], nextCursor: `${id}\n` },
      { files: [item()], nextCursor: null, totalCount: 1000 },
      { files: [item(), item()], nextCursor: null },
      {
        files: Array.from({ length: 51 }, (_, i) => ({ ...item(), file_id: String(i) })),
        nextCursor: id,
      },
      { files: new Array(1), nextCursor: null },
    ]) {
      expect(readFileLibraryPage(page)).toBeNull();
    }
  });
});

describe.each<[string, (value: unknown) => unknown, () => object]>([
  ['query', readFileLibraryQuery, () => ({ limit: 25 })],
  ['update', readFileLibraryUpdate, () => ({ expectedRevision: 0, tags: [] })],
  ['metadata', readFileLibraryMetadata, metadata],
  ['item', readFileLibraryItem, item],
  ['page', readFileLibraryPage, () => ({ files: [item()], nextCursor: null })],
])('strict %s record', (_name, read, valid) => {
  test('rejects unknown, inherited, hidden and accessor properties without executing getters', () => {
    const getter = jest.fn(() => {
      throw new Error('must not execute');
    });
    const accessor = valid();
    Object.defineProperty(accessor, Object.keys(accessor)[0], { get: getter, enumerable: true });
    for (const value of [
      null,
      [],
      'value',
      1,
      Object.create(valid()),
      { ...valid(), [Symbol('private')]: true },
      Object.defineProperty(valid(), 'private', { value: true }),
      Object.assign(valid(), JSON.parse('{"__proto__":{"approved":true}}')),
      accessor,
      new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error('unreadable');
          },
        },
      ),
    ]) {
      expect(read(value)).toBeNull();
    }
    expect(getter).not.toHaveBeenCalled();
  });
});
