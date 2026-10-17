import { useMemo, useState } from 'react';
import { Button } from '@librechat/client';
import type { DocumentElement, DocumentStructure, DocumentWarning } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';

type Props = {
  text: string;
  structure: DocumentStructure;
  initialPage?: number;
  initialElementId?: string;
};
type Section = { start: number; end: number; page: number | null; element?: DocumentElement };
const CHUNK_SIZE = 16_384;
const warnings: Record<DocumentWarning, TranslationKeys> = {
  layout_unavailable: 'com_document_source_layout',
  visual_content_not_extracted: 'com_document_source_visual',
  table_structure_unavailable: 'com_document_source_tables',
  unsupported_content: 'com_document_source_unsupported',
};

/** Root elements own reading order. Preserve uncovered text without assigning invented pages. */
function sectionsFor(text: string, structure: DocumentStructure): Section[] {
  const result: Section[] = [];
  let end = 0;
  for (const element of structure.elements) {
    if (element.parentId !== null) continue;
    let start = element.start;
    if (start > end) {
      if (/^\s*$/.test(text.slice(end, start))) {
        if (result.length) result[result.length - 1].end = start;
        else start = end;
      } else result.push({ start: end, end: start, page: null });
    }
    result.push({ start, end: element.end, page: element.page, element });
    end = element.end;
  }
  if (end < text.length) {
    if (result.length && /^\s*$/.test(text.slice(end))) result[result.length - 1].end = text.length;
    else result.push({ start: end, end: text.length, page: null });
  }
  return result;
}

function chunksFor(text: string, section?: Section): Array<{ start: number; end: number }> {
  if (!section) return [];
  const chunks: Array<{ start: number; end: number }> = [];
  for (let start = section.start; start < section.end; ) {
    let end = Math.min(start + CHUNK_SIZE, section.end);
    const next = text.charCodeAt(end);
    if (end < section.end && next >= 0xdc00 && next <= 0xdfff) end--;
    chunks.push({ start, end });
    start = end;
  }
  return chunks.length ? chunks : [{ start: section.start, end: section.end }];
}

/** Only render a small, complete native cell grid; all other tables retain their full text view. */
function tableFor(text: string, section: Section | undefined, structure: DocumentStructure) {
  if (section?.element?.kind !== 'table' || section.end - section.start > CHUNK_SIZE) return null;
  const cells = structure.elements.filter(
    (item) => item.parentId === section.element!.id && item.kind === 'cell',
  );
  if (!cells.length || cells.length > 64) return null;
  const rows = Math.max(...cells.map((item) => item.cell!.row + item.cell!.rowSpan));
  const columns = Math.max(...cells.map((item) => item.cell!.column + item.cell!.columnSpan));
  if (rows > 32 || columns > 16 || rows * columns > 128) return null;
  const occupied = new Set<string>();
  let end = section.start;
  for (const item of cells) {
    if (text.slice(end, item.start).trim()) return null;
    end = item.end;
    const cell = item.cell!;
    for (let row = cell.row; row < cell.row + cell.rowSpan; row++)
      for (let column = cell.column; column < cell.column + cell.columnSpan; column++)
        occupied.add(`${row}:${column}`);
  }
  if (occupied.size !== rows * columns || text.slice(end, section.end).trim()) return null;
  return Array.from({ length: rows }, (_, row) =>
    cells.filter((item) => item.cell!.row === row).sort((a, b) => a.cell!.column - b.cell!.column),
  );
}

function Position({
  unit,
  current,
  total,
  onChange,
}: {
  unit: TranslationKeys;
  current: number;
  total: number;
  onChange: (index: number) => void;
}) {
  const localize = useLocalize();
  const name = localize(unit);
  return (
    <nav aria-label={name} className="flex flex-wrap items-center gap-2 text-sm">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={current <= 0}
        aria-label={`${localize('com_document_source_previous')} (${name})`}
        onClick={() => onChange(current - 1)}
      >
        {localize('com_document_source_previous')}
      </Button>
      <span role="status" aria-live="polite" aria-atomic="true">
        {localize('com_document_source_position', { unit: name, current: current + 1, total })}
      </span>
      {total > 1 && (
        <input
          type="number"
          min={1}
          max={total}
          value={current + 1}
          aria-label={`${localize('com_document_source_jump')} ${name}`}
          className="border-border-light bg-surface-primary text-text-primary focus-visible:ring-focus-subtle w-20 rounded-md border px-2 py-1 focus-visible:ring-2"
          onChange={(event) => {
            const value = Number(event.target.value);
            if (Number.isInteger(value) && value >= 1 && value <= total) onChange(value - 1);
          }}
        />
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={current >= total - 1}
        aria-label={`${localize('com_document_source_next')} (${name})`}
        onClick={() => onChange(current + 1)}
      >
        {localize('com_document_source_next')}
      </Button>
    </nav>
  );
}

function SourceView({ text, structure, initialPage, initialElementId }: Props) {
  const localize = useLocalize();
  const sections = useMemo(() => sectionsFor(text, structure), [text, structure]);
  const elements = useMemo(
    () => new Map(structure.elements.map((item) => [item.id, item])),
    [structure],
  );
  const initialElement = elements.get(initialElementId ?? '');
  let root = initialElement;
  while (root?.parentId) root = elements.get(root.parentId);
  const rootId = root?.id;
  const initialSection = rootId ? sections.findIndex((item) => item.element?.id === rootId) : -1;
  const [page, setPage] = useState<number | null>(() => {
    if (initialSection >= 0) return sections[initialSection].page;
    if (structure.pages.some((item) => item.number === initialPage)) return initialPage!;
    return structure.pages[0]?.number ?? null;
  });
  const [sectionIndex, setSectionIndex] = useState(() =>
    initialSection >= 0 ? initialSection : sections.findIndex((item) => item.page === page),
  );
  const section = sections[sectionIndex];
  const chunks = useMemo(() => chunksFor(text, section), [text, section]);
  const [chunkIndex, setChunkIndex] = useState(() =>
    initialElement
      ? Math.max(
          0,
          chunks.findIndex(
            (item) => item.start <= initialElement.start && item.end > initialElement.start,
          ),
        )
      : 0,
  );
  const [elementId, setElementId] = useState(initialElement?.id);
  const selected = elements.get(elementId ?? '');
  const visibleSections = useMemo(
    () =>
      sections
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => !structure.pages.length || item.page === page),
    [sections, structure.pages.length, page],
  );
  const table = useMemo(() => tableFor(text, section, structure), [text, section, structure]);
  const chunk = chunks[chunkIndex] ?? chunks[0];
  const anchor = (id: string) =>
    `document-${structure.source.sha256}-${structure.extractor.name}-${structure.extractor.version}-${id}`;
  const pickSection = (index: number) => {
    setSectionIndex(index);
    setChunkIndex(0);
    setElementId(sections[index]?.element?.id);
  };
  const unassigned = structure.pages.length > 0 && sections.some((item) => item.page === null);
  const pageUnit =
    structure.pages[0]?.kind === 'slide' ? 'com_document_source_slide' : 'com_document_source_page';
  const markedStart = selected && chunk ? Math.max(chunk.start, selected.start) : 0;
  const markedEnd = selected && chunk ? Math.min(chunk.end, selected.end) : 0;
  return (
    <section
      aria-label={localize('com_document_source_title')}
      className="text-text-primary min-w-0 space-y-4"
    >
      <p className="text-text-secondary text-sm">{localize('com_document_source_description')}</p>
      {structure.quality.status === 'partial' && (
        <div
          className="border-border-light bg-surface-secondary rounded-lg border p-3 text-sm"
          role="note"
        >
          <p className="font-medium">{localize('com_document_source_partial')}</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {structure.quality.warnings.map((warning) => (
              <li key={warning}>{localize(warnings[warning])}</li>
            ))}
          </ul>
        </div>
      )}
      {structure.pages.length > 0 && (
        <>
          {page !== null && (
            <Position
              unit={pageUnit}
              current={page - 1}
              total={structure.pages.length}
              onChange={(index) => {
                const next = structure.pages[index].number;
                setPage(next);
                pickSection(sections.findIndex((item) => item.page === next));
              }}
            />
          )}
          {unassigned && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const next = page === null ? structure.pages[0].number : null;
                setPage(next);
                pickSection(sections.findIndex((item) => item.page === next));
              }}
            >
              {page === null
                ? `${localize(pageUnit)} 1`
                : localize('com_document_source_unassigned')}
            </Button>
          )}
        </>
      )}
      {visibleSections.length > 0 && (
        <Position
          unit="com_document_source_section"
          current={Math.max(
            0,
            visibleSections.findIndex((item) => item.index === sectionIndex),
          )}
          total={visibleSections.length}
          onChange={(index) => pickSection(visibleSections[index].index)}
        />
      )}
      {!section && (
        <p className="text-text-secondary text-sm">{localize('com_document_source_empty')}</p>
      )}
      {section && !section.element && (
        <p className="text-text-secondary text-sm">{localize('com_document_source_unassigned')}</p>
      )}
      {chunk && (
        <div
          id={section.element ? anchor(section.element.id) : undefined}
          className="border-border-light bg-surface-secondary min-w-0 rounded-lg border p-4"
        >
          {table ? (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <caption className="text-text-secondary mb-2 text-left">
                  {localize('com_document_source_table')}
                </caption>
                <tbody>
                  {table.map((cells, row) => (
                    <tr key={row}>
                      {cells.map((cell) => (
                        <td
                          key={cell.id}
                          id={anchor(cell.id)}
                          rowSpan={cell.cell!.rowSpan}
                          colSpan={cell.cell!.columnSpan}
                          className="border-border-light border p-2 align-top break-words whitespace-pre-wrap"
                        >
                          {text.slice(cell.start, cell.end)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <pre
              aria-label={localize('com_document_source_text')}
              className="font-sans text-sm leading-6 break-words whitespace-pre-wrap"
            >
              {markedStart < markedEnd ? (
                <>
                  {text.slice(chunk.start, markedStart)}
                  <mark
                    id={selected!.id !== section.element?.id ? anchor(selected!.id) : undefined}
                    className="bg-surface-tertiary text-text-primary"
                  >
                    {text.slice(markedStart, markedEnd)}
                  </mark>
                  {text.slice(markedEnd, chunk.end)}
                </>
              ) : (
                text.slice(chunk.start, chunk.end)
              )}
            </pre>
          )}
        </div>
      )}
      {chunks.length > 1 && (
        <Position
          unit="com_document_source_excerpt"
          current={chunkIndex}
          total={chunks.length}
          onChange={setChunkIndex}
        />
      )}
    </section>
  );
}

/** The caller validates ManagedDocumentResult. This view neither fetches nor interprets markup. */
export default function DocumentSourceView(props: Props) {
  return (
    <SourceView
      key={`${props.structure.source.sha256}/${props.structure.extractor.name}/${props.structure.extractor.version}/${props.initialPage}/${props.initialElementId}`}
      {...props}
    />
  );
}
