import { readManagedDocumentResult } from './document-structure';

function result() {
  return {
    text: 'Titel\nA\tB',
    structure: {
      version: 1,
      source: { sha256: 'a'.repeat(64), bytes: 100, mediaType: 'text/plain' },
      extractor: { name: 'native', version: '1' },
      pages: [],
      elements: [
        { id: 'e1', kind: 'heading', start: 0, end: 5, page: null, parentId: null },
        { id: 'e2', kind: 'table', start: 6, end: 9, page: null, parentId: null },
        {
          id: 'e3',
          kind: 'cell',
          start: 6,
          end: 7,
          page: null,
          parentId: 'e2',
          cell: { row: 0, column: 0, rowSpan: 1, columnSpan: 1 },
        },
        {
          id: 'e4',
          kind: 'cell',
          start: 8,
          end: 9,
          page: null,
          parentId: 'e2',
          cell: { row: 0, column: 1, rowSpan: 1, columnSpan: 1 },
        },
      ],
      quality: { status: 'complete', warnings: [] },
    },
  };
}

describe('versioned native document structure', () => {
  it('validates a source-bound structured master without changing text or input', () => {
    const input = result();
    const before = JSON.stringify(input);
    expect(readManagedDocumentResult(input)).toEqual(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(readManagedDocumentResult(input)).not.toBe(input);
  });

  it.each([
    (input: ReturnType<typeof result>) => {
      input.structure.version = 2;
    },
    (input: ReturnType<typeof result>) => {
      input.structure.source.sha256 = '../private';
    },
    (input: ReturnType<typeof result>) => {
      input.structure.elements[2].parentId = 'e4';
    },
    (input: ReturnType<typeof result>) => {
      input.structure.elements[2].end = 99;
    },
    (input: ReturnType<typeof result>) => {
      input.structure.elements[2].id = 'e1';
    },
    (input: ReturnType<typeof result>) => {
      input.structure.elements[3].cell!.column = 0;
    },
    (input: ReturnType<typeof result>) => {
      input.structure.elements[3].page = 1 as never;
    },
    (input: ReturnType<typeof result>) => {
      input.structure.quality.status = 'partial';
    },
    (input: ReturnType<typeof result>) => {
      Object.assign(input.structure, { authorization: 'approved' });
    },
    (input: ReturnType<typeof result>) => {
      input.text = ' ';
    },
  ])('rejects a malformed or contradictory result %#', (mutate) => {
    const input = result();
    mutate(input);
    expect(readManagedDocumentResult(input)).toBeNull();
  });

  it('retains actual partial extraction rather than inventing completeness', () => {
    const input = result();
    Object.assign(input.structure.quality, {
      status: 'partial',
      warnings: ['visual_content_not_extracted'],
    });
    expect(readManagedDocumentResult(input)?.structure.quality.status).toBe('partial');
  });

  it('permits absent anchors only when extraction is explicitly partial', () => {
    const input = result();
    input.structure.elements = [];
    expect(readManagedDocumentResult(input)).toBeNull();
    Object.assign(input.structure.quality, {
      status: 'partial',
      warnings: ['unsupported_content'],
    });
    expect(readManagedDocumentResult(input)?.structure.elements).toEqual([]);
  });

  it('requires contiguous actual pages and valid references', () => {
    const input = result();
    input.structure.source.mediaType = 'application/pdf';
    Object.assign(input.structure, { pages: [{ number: 1, kind: 'page' }] });
    for (const element of input.structure.elements) element.page = 1 as never;
    expect(readManagedDocumentResult(input)).not.toBeNull();
    Object.assign(input.structure, { pages: [{ number: 2, kind: 'page' }] });
    expect(readManagedDocumentResult(input)).toBeNull();
  });

  it('rejects fabricated pagination for native TXT/CSV/DOCX or wrong PDF/PPTX page kinds', () => {
    for (const mediaType of [
      'text/plain',
      'text/csv',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]) {
      const input = result();
      input.structure.source.mediaType = mediaType;
      Object.assign(input.structure, { pages: [{ number: 1, kind: 'page' }] });
      expect(readManagedDocumentResult(input)).toBeNull();
    }
    for (const mediaType of [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ]) {
      const input = result();
      input.structure.source.mediaType = mediaType;
      expect(readManagedDocumentResult(input)).toBeNull();
      Object.assign(input.structure, {
        pages: [{ number: 1, kind: mediaType === 'application/pdf' ? 'slide' : 'page' }],
      });
      for (const element of input.structure.elements) element.page = 1 as never;
      expect(readManagedDocumentResult(input)).toBeNull();
    }
  });

  it('retains native CSV cells and UTF-16 ranges without inventing pagination', () => {
    const input = result();
    input.structure.source.mediaType = 'text/csv';
    input.text = '🧭\t\n\tB';
    input.structure.elements = [
      { id: 'e1', kind: 'table', start: 0, end: 6, page: null, parentId: null },
      ...[
        [0, 2, 0, 0],
        [3, 3, 0, 1],
        [4, 4, 1, 0],
        [5, 6, 1, 1],
      ].map(([start, end, row, column], index) => ({
        id: `e${index + 2}`,
        kind: 'cell',
        start,
        end,
        page: null,
        parentId: 'e1',
        cell: { row, column, rowSpan: 1, columnSpan: 1 },
      })),
    ];
    const before = JSON.stringify(input);
    expect(readManagedDocumentResult(input)).toEqual(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(['', ' \t\n'])(
    'keeps entirely empty CSV documents outside normal processing %#',
    (text) => {
      const input = result();
      input.structure.source.mediaType = 'text/csv';
      input.text = text;
      input.structure.elements = [
        { id: 'e1', kind: 'table', start: 0, end: text.length, page: null, parentId: null },
        {
          id: 'e2',
          kind: 'cell',
          start: 0,
          end: text.length,
          page: null,
          parentId: 'e1',
          cell: { row: 0, column: 0, rowSpan: 1, columnSpan: 1 },
        },
      ];
      expect(readManagedDocumentResult(input)).toBeNull();
    },
  );

  it('uses UTF-16 ranges without splitting a Unicode character', () => {
    const input = result();
    input.text = '🧭';
    input.structure.elements = [
      { id: 'e1', kind: 'paragraph', start: 0, end: 2, page: null, parentId: null },
    ];
    expect(readManagedDocumentResult(input)).not.toBeNull();
    input.structure.elements[0].end = 1;
    expect(readManagedDocumentResult(input)).toBeNull();
  });

  it('bounds text, graph size and expanded table cells before accepting content', () => {
    const input = result();
    input.text = 'α'.repeat(8 * 1024 * 1024);
    expect(readManagedDocumentResult(input)).toBeNull();
    const large = result();
    large.structure.elements[2].cell!.rowSpan = 20_000;
    large.structure.elements[2].cell!.columnSpan = 20_000;
    expect(readManagedDocumentResult(large)).toBeNull();
    expect(
      readManagedDocumentResult({
        ...result(),
        structure: { ...result().structure, elements: new Array(20_001).fill({}) },
      }),
    ).toBeNull();
  });
});
