/** Parser-local provenance and exact native XML ranges; never a security approval. */
import { createHash } from 'node:crypto';
import { MANAGED_STRUCTURE_MAX_BYTES } from 'librechat-data-provider';
import type { DocumentElement, DocumentStructure, DocumentWarning } from 'librechat-data-provider';

export const wordNS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const drawingNS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

export class ManagedStructure {
  readonly value: DocumentStructure;
  private cellArea = 0;

  constructor(
    data: Buffer,
    mediaType: string,
    readonly limit: () => never,
  ) {
    this.value = {
      version: 1,
      source: {
        sha256: createHash('sha256').update(data).digest('hex'),
        bytes: data.length,
        mediaType,
      },
      extractor: { name: 'librechat-managed', version: '1' },
      pages: [],
      elements: [],
      quality: { status: 'complete', warnings: [] },
    };
  }

  warn(warning: DocumentWarning): void {
    this.value.quality.status = 'partial';
    if (!this.value.quality.warnings.includes(warning)) this.value.quality.warnings.push(warning);
  }

  add(
    kind: DocumentElement['kind'],
    start: number,
    end: number,
    page: number | null = null,
    parentId: string | null = null,
    cell?: DocumentElement['cell'],
  ): DocumentElement {
    if (this.value.elements.length >= 20_000) this.limit();
    if (cell && (this.cellArea += cell.rowSpan * cell.columnSpan) > 20_000) this.limit();
    const element: DocumentElement = {
      id: `e${this.value.elements.length + 1}`,
      kind,
      start,
      end,
      page,
      parentId,
      ...(cell ? { cell } : {}),
    };
    this.value.elements.push(element);
    return element;
  }

  finish(): DocumentStructure {
    if (Buffer.byteLength(JSON.stringify(this.value), 'utf8') > MANAGED_STRUCTURE_MAX_BYTES) {
      this.limit();
    }
    return this.value;
  }
}

/** Plain-text paragraphs are delimited by blank lines; offsets retain all source line endings. */
export function plainParagraphs(text: string, structure: ManagedStructure): void {
  const breaks = /(?:\r?\n|\r(?!\n))[\t ]*(?:\r?\n|\r(?!\n))/g;
  let start = 0;
  const add = (end: number) => {
    const part = text.slice(start, end);
    const trimmed = part.trim();
    if (trimmed) {
      const leading = part.search(/\S/u);
      structure.add('paragraph', start + leading, start + leading + trimmed.length);
    }
  };
  let match: RegExpExecArray | null;
  while ((match = breaks.exec(text))) {
    add(match.index);
    start = match.index + match[0].length;
  }
  add(text.length);
}

function children(node: Element, namespace: string, name: string): Element[] {
  return Array.from(node.children).filter(
    (item) => item.namespaceURI === namespace && item.localName === name,
  );
}

function child(node: Element | undefined, namespace: string, name: string): Element | undefined {
  return node ? children(node, namespace, name)[0] : undefined;
}

function positive(value: string | null): number | null {
  if (value === null) return 1;
  return /^[1-9][0-9]{0,4}$/.test(value) && Number(value) <= 20_000 ? Number(value) : null;
}

/** Explicit outline levels (including inherited styles), never a heading guessed from its text. */
function headings(styles?: Document): (node: Element) => boolean {
  const byId = new Map(
    Array.from(styles?.getElementsByTagNameNS(wordNS, 'style') ?? []).map((node) => [
      node.getAttributeNS(wordNS, 'styleId'),
      node,
    ]),
  );
  return (node) => {
    let properties = child(node, wordNS, 'pPr');
    let id = child(properties, wordNS, 'pStyle')?.getAttributeNS(wordNS, 'val');
    const visited = new Set<string>();
    while (properties || id) {
      const outline = child(properties, wordNS, 'outlineLvl')?.getAttributeNS(wordNS, 'val');
      if (outline !== undefined) return /^[0-8]$/.test(outline ?? '');
      if (!id || visited.has(id)) break;
      visited.add(id);
      const style = byId.get(id);
      properties = child(style, wordNS, 'pPr');
      id = child(style, wordNS, 'basedOn')?.getAttributeNS(wordNS, 'val');
    }
    return false;
  };
}

/**
 * Keep Mammoth's public raw text authoritative. Only an exact whole-output match certifies these
 * structural offsets; unsupported XML never gets fuzzy text matching or invented positions.
 */
export function wordStructure(
  doc: Document,
  styles: Document | undefined,
  text: string,
  structure: ManagedStructure,
): void {
  const chunks: string[] = [];
  let length = 0;
  const isHeading = headings(styles);
  const add = (value: string) => {
    length += value.length;
    if (length > 15 * 1024 * 1024) structure.limit();
    chunks.push(value);
  };
  const walk = (node: Element, parent: string | null, depth: number): void => {
    if (depth > 128) structure.limit();
    if (node.namespaceURI !== wordNS) {
      structure.warn('unsupported_content');
      return;
    }
    const name = node.localName;
    if (name === 't') {
      add(node.textContent ?? '');
      return;
    }
    if (name === 'tab') {
      add('\t');
      return;
    }
    if (name === 'noBreakHyphen') {
      add('\u2011');
      return;
    }
    if (name === 'softHyphen') {
      add('\u00ad');
      return;
    }
    if (name === 'del' || name === 'moveFrom') {
      structure.warn('unsupported_content');
      return;
    }
    if (
      [
        'pPr',
        'rPr',
        'tblPr',
        'tblGrid',
        'trPr',
        'tcPr',
        'sectPr',
        'bookmarkStart',
        'bookmarkEnd',
        'proofErr',
        'lastRenderedPageBreak',
      ].includes(name)
    )
      return;
    if (name === 'br' || name === 'cr') {
      // Mammoth raw text omits rendered breaks; preserve that native text contract.
      structure.warn('layout_unavailable');
      return;
    }
    if (['drawing', 'pict', 'object'].includes(name)) {
      structure.warn('visual_content_not_extracted');
      structure.warn('unsupported_content');
      return;
    }
    if (name === 'p') {
      const start = length;
      for (const item of Array.from(node.children)) walk(item, parent, depth + 1);
      if (length > start)
        structure.add(isHeading(node) ? 'heading' : 'paragraph', start, length, null, parent);
      add('\n\n');
      return;
    }
    if (name === 'tbl') {
      const rows = children(node, wordNS, 'tr');
      const unsupported =
        node.getElementsByTagNameNS(wordNS, 'vMerge').length > 0 ||
        node.getElementsByTagNameNS(wordNS, 'hMerge').length > 0 ||
        node.getElementsByTagNameNS(wordNS, 'gridBefore').length > 0 ||
        node.getElementsByTagNameNS(wordNS, 'gridAfter').length > 0;
      if (unsupported) {
        structure.warn('table_structure_unavailable');
      } else {
        const table = structure.add('table', length, length, null, parent);
        let area = 0;
        rows.forEach((row, rowNumber) => {
          let column = 0;
          for (const cell of children(row, wordNS, 'tc')) {
            const span = positive(
              child(child(cell, wordNS, 'tcPr'), wordNS, 'gridSpan')?.getAttributeNS(
                wordNS,
                'val',
              ) ?? null,
            );
            if (span === null || (area += span) > 20_000) structure.limit();
            const element = structure.add('cell', length, length, null, table.id, {
              row: rowNumber,
              column,
              rowSpan: 1,
              columnSpan: span,
            });
            for (const item of Array.from(cell.children)) walk(item, element.id, depth + 1);
            element.end = length;
            column += span;
          }
        });
        table.end = length;
        return;
      }
    }
    if (
      ![
        'document',
        'body',
        'r',
        'hyperlink',
        'ins',
        'sdt',
        'sdtContent',
        'smartTag',
        'tbl',
        'tr',
        'tc',
      ].includes(name)
    ) {
      structure.warn('unsupported_content');
      return;
    }
    for (const item of Array.from(node.children)) walk(item, parent, depth + 1);
  };
  walk(doc.documentElement, null, 0);
  if (chunks.join('') !== text) {
    structure.value.elements = [];
    structure.warn('unsupported_content');
    if (doc.getElementsByTagNameNS(wordNS, 'tbl').length)
      structure.warn('table_structure_unavailable');
  }
}

/** Slide order comes from presentation relationships; table coordinates come only from native XML. */
export function slideStructure(
  doc: Document,
  page: number,
  structure: ManagedStructure,
  output: { readonly length: number; add(value: string): void },
): void {
  const walk = (node: Element, parent: string | null, depth: number): void => {
    if (depth > 128) structure.limit();
    if (node.namespaceURI === drawingNS && node.localName === 'p') {
      const start = output.length;
      for (const run of Array.from(node.getElementsByTagNameNS(drawingNS, 't'))) {
        output.add(run.textContent ?? '');
      }
      if (output.length > start) structure.add('paragraph', start, output.length, page, parent);
      output.add('\n');
      return;
    }
    if (node.namespaceURI === drawingNS && node.localName === 'tbl') {
      const cells = Array.from(node.getElementsByTagNameNS(drawingNS, 'tc'));
      const rows = children(node, drawingNS, 'tr');
      const directCells = rows.reduce<Element[]>(
        (all, row) => all.concat(children(row, drawingNS, 'tc')),
        [],
      );
      const cellSet = new Set(directCells);
      const unusual =
        cells.length !== directCells.length ||
        Array.from(node.getElementsByTagNameNS(drawingNS, 'p')).some((paragraph) => {
          let parent = paragraph.parentElement;
          let depth = 0;
          while (parent && parent !== node && !cellSet.has(parent) && depth++ < 128)
            parent = parent.parentElement;
          return !parent || !cellSet.has(parent);
        });
      const merged = cells.some(
        (cell) =>
          ['rowSpan', 'gridSpan'].some(
            (key) => cell.hasAttribute(key) && cell.getAttribute(key) !== '1',
          ) ||
          ['hMerge', 'vMerge'].some(
            (key) =>
              cell.hasAttribute(key) && !['0', 'false'].includes(cell.getAttribute(key) ?? ''),
          ),
      );
      if (merged || unusual) structure.warn('table_structure_unavailable');
      else {
        const table = structure.add('table', output.length, output.length, page, parent);
        children(node, drawingNS, 'tr').forEach((row, rowNumber) => {
          children(row, drawingNS, 'tc').forEach((cell, column) => {
            const element = structure.add('cell', output.length, output.length, page, table.id, {
              row: rowNumber,
              column,
              rowSpan: 1,
              columnSpan: 1,
            });
            for (const item of Array.from(cell.children)) walk(item, element.id, depth + 1);
            element.end = output.length;
          });
        });
        table.end = output.length;
        return;
      }
    }
    if (['pic', 'blip', 'chart', 'oleObj', 'videoFile', 'audioFile'].includes(node.localName)) {
      structure.warn('visual_content_not_extracted');
    }
    for (const item of Array.from(node.children)) walk(item, parent, depth + 1);
  };
  walk(doc.documentElement, null, 0);
}
