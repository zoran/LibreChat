import { z } from 'zod';

export const MANAGED_TEXT_MAX_BYTES = 15 * 1024 * 1024;
export const MANAGED_STRUCTURE_MAX_BYTES = 512 * 1024;
export const MANAGED_DOCUMENT_WIRE_MAX_BYTES =
  MANAGED_TEXT_MAX_BYTES + MANAGED_STRUCTURE_MAX_BYTES + 4;

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().regex(/^e[1-9][0-9]{0,5}$/);
const warning = z.enum([
  'layout_unavailable',
  'visual_content_not_extracted',
  'table_structure_unavailable',
  'unsupported_content',
]);
const element = z
  .object({
    id: identifier,
    kind: z.enum(['paragraph', 'heading', 'table', 'cell']),
    start: integer,
    end: integer,
    page: z.number().int().min(1).max(500).nullable(),
    parentId: identifier.nullable(),
    cell: z
      .object({
        row: z.number().int().min(0).max(20_000),
        column: z.number().int().min(0).max(20_000),
        rowSpan: z.number().int().min(1).max(20_000),
        columnSpan: z.number().int().min(1).max(20_000),
      })
      .strict()
      .optional(),
  })
  .strict();
const structure = z
  .object({
    version: z.literal(1),
    source: z
      .object({
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z
          .number()
          .int()
          .min(1)
          .max(30 * 1024 * 1024),
        mediaType: z
          .string()
          .regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/)
          .max(127),
      })
      .strict(),
    extractor: z
      .object({
        name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),
        version: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,79}$/),
      })
      .strict(),
    pages: z
      .array(
        z
          .object({ number: z.number().int().min(1).max(500), kind: z.enum(['page', 'slide']) })
          .strict(),
      )
      .max(500),
    elements: z.array(element).max(20_000),
    quality: z
      .object({ status: z.enum(['complete', 'partial']), warnings: z.array(warning).max(4) })
      .strict(),
  })
  .strict();
const result = z
  .object({ text: z.string().min(1).max(MANAGED_TEXT_MAX_BYTES), structure })
  .strict();

export type DocumentStructure = z.infer<typeof structure>;
export type DocumentPage = DocumentStructure['pages'][number];
export type DocumentElement = DocumentStructure['elements'][number];
export type DocumentWarning = z.infer<typeof warning>;
export type ManagedDocumentResult = z.infer<typeof result>;

/** Validate one canonical representation; source identity must also match the authorized original. */
export function readManagedDocumentResult(value: unknown): ManagedDocumentResult | null {
  try {
    const raw = value as ManagedDocumentResult | undefined;
    if (
      !raw ||
      typeof raw.text !== 'string' ||
      raw.text.length > MANAGED_TEXT_MAX_BYTES ||
      !Array.isArray(raw.structure?.elements) ||
      raw.structure.elements.length > 20_000 ||
      !Array.isArray(raw.structure.pages) ||
      raw.structure.pages.length > 500
    )
      return null;
    const parsed = result.safeParse(value);
    if (!parsed.success) return null;
    const current = parsed.data;
    const { text, structure: document } = current;
    const encoder = new TextEncoder();
    if (
      !text.trim() ||
      encoder.encode(text).length > MANAGED_TEXT_MAX_BYTES ||
      encoder.encode(JSON.stringify(document)).length > MANAGED_STRUCTURE_MAX_BYTES ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)
    )
      return null;
    if (
      (document.quality.status === 'complete') !== (document.quality.warnings.length === 0) ||
      new Set(document.quality.warnings).size !== document.quality.warnings.length ||
      (document.quality.status === 'complete' && document.elements.length === 0)
    )
      return null;
    if (
      document.pages.some(
        (page, index) => page.number !== index + 1 || page.kind !== document.pages[0].kind,
      )
    )
      return null;
    const mediaType = document.source.mediaType;
    const pageless =
      mediaType === 'text/plain' ||
      mediaType === 'text/csv' ||
      mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    let pageKind: 'page' | 'slide' | undefined;
    if (mediaType === 'application/pdf') pageKind = 'page';
    else if (
      mediaType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    )
      pageKind = 'slide';
    if (
      (pageless && document.pages.length !== 0) ||
      (pageKind &&
        (document.pages.length === 0 || document.pages.some((page) => page.kind !== pageKind))) ||
      (pageKind && document.elements.some((item) => item.page === null))
    )
      return null;
    const byId = new Map<string, DocumentElement>();
    const occupied = new Set<string>();
    const siblingEnd = new Map<string | null, number>();
    let cells = 0;
    const boundary = (offset: number) =>
      offset === text.length ||
      !(text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff);
    for (const item of document.elements) {
      if (
        byId.has(item.id) ||
        item.start > item.end ||
        item.end > text.length ||
        !boundary(item.start) ||
        !boundary(item.end) ||
        (item.start === item.end && item.kind !== 'table' && item.kind !== 'cell') ||
        (item.page !== null && item.page > document.pages.length) ||
        (item.kind === 'cell') !== (item.cell !== undefined)
      )
        return null;
      const parent = item.parentId === null ? undefined : byId.get(item.parentId);
      if (
        item.parentId !== null &&
        (!parent || parent.start > item.start || parent.end < item.end || parent.page !== item.page)
      )
        return null;
      if (item.kind === 'cell' && parent?.kind !== 'table') return null;
      if (item.start < (siblingEnd.get(item.parentId) ?? 0)) return null;
      siblingEnd.set(item.parentId, item.end);
      if (item.cell) {
        const cell = item.cell;
        cells += cell.rowSpan * cell.columnSpan;
        if (cells > 20_000) return null;
        for (let row = cell.row; row < cell.row + cell.rowSpan; row++) {
          for (let column = cell.column; column < cell.column + cell.columnSpan; column++) {
            const key = `${item.parentId}:${row}:${column}`;
            if (occupied.has(key)) return null;
            occupied.add(key);
          }
        }
      }
      byId.set(item.id, item);
    }
    return current;
  } catch {
    return null;
  }
}
