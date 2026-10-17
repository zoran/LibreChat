import JSZip from 'jszip';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { readManagedDocumentResult } from 'librechat-data-provider';
import { mkdir, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { extractManagedDocument, MANAGED_DOCUMENT_TYPES } from './managed';
import { MANAGED_CSV_LIMITS } from './csv';

// Jest's CommonJS transform cannot parse PDF.js import.meta. Load the actual installed ESM module
// through native Node (including its real worker); this replaces no PDF behavior with a fake.
jest.mock('pdfjs-dist/legacy/build/pdf.mjs', () => {
  return process.getBuiltinModule('module').createRequire(__filename)(
    'pdfjs-dist/legacy/build/pdf.mjs',
  );
});

const NS = {
  word: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  presentation: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  drawing: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  relationship: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  package: 'http://schemas.openxmlformats.org/package/2006/relationships',
};

describe('managed useful extraction and hard limits', () => {
  let root: string;
  beforeAll(async () => {
    const directory = process.env.UPLOAD_TEST_TMPDIR ?? tmpdir();
    await mkdir(directory, { recursive: true });
    root = await mkdtemp(path.join(directory, 'documents-'));
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function text(data: Buffer | string, limits = {}) {
    const filePath = path.join(root, 'original');
    await writeFile(filePath, data);
    return extractManagedDocument({ filePath, mediaType: 'text/plain', limits });
  }

  async function csv(data: Buffer | string, limits = {}) {
    const filePath = path.join(root, 'original.csv');
    await writeFile(filePath, data);
    return extractManagedDocument({ filePath, mediaType: 'text/csv', limits });
  }

  describe('CSV structured extraction', () => {
    it('preserves every decoded cell with stable coordinates and exact UTF-16 ranges', async () => {
      const source =
        '\uFEFFName,Value,Note,Empty\r\n"Grüße 😀",-001.20,"line 1\r\nline ""2"", α",\r\n,-0.50,"  spaced\tvalue  ",""\r\n';
      const rows = [
        ['Name', 'Value', 'Note', 'Empty'],
        ['Grüße 😀', '-001.20', 'line 1\r\nline "2", α', ''],
        ['', '-0.50', '  spaced\tvalue  ', ''],
      ];
      const result = await csv(source);
      const expectedText = rows.map((row) => row.join('\t')).join('\n');
      expect(result.text).toBe(expectedText);
      expect(result.bytes).toBe(Buffer.byteLength(expectedText, 'utf8'));
      expect(result.structure.source).toEqual({
        bytes: Buffer.byteLength(source, 'utf8'),
        sha256: createHash('sha256').update(source).digest('hex'),
        mediaType: 'text/csv',
      });
      expect(result.structure.pages).toEqual([]);
      expect(result.structure.quality).toEqual({ status: 'complete', warnings: [] });
      const [table, ...cells] = result.structure.elements;
      expect(table).toEqual({
        id: 'e1',
        kind: 'table',
        start: 0,
        end: expectedText.length,
        page: null,
        parentId: null,
      });
      expect(cells).toHaveLength(12);
      expect(cells.map((cell) => [cell.start, cell.end])).toEqual([
        [0, 4],
        [5, 10],
        [11, 15],
        [16, 21],
        [22, 30],
        [31, 38],
        [39, 58],
        [59, 59],
        [60, 60],
        [61, 66],
        [67, 83],
        [84, 84],
      ]);
      expect(cells.map((cell) => result.text.slice(cell.start, cell.end))).toEqual(rows.flat());
      expect(cells.map((cell) => cell.cell)).toEqual(
        rows.flatMap((row, rowIndex) =>
          row.map((_, column) => ({ row: rowIndex, column, rowSpan: 1, columnSpan: 1 })),
        ),
      );
      expect(
        cells.every(
          (cell) => cell.kind === 'cell' && cell.page === null && cell.parentId === table.id,
        ),
      ).toBe(true);
      expect(cells.map((cell) => cell.id)).toEqual(
        Array.from({ length: 12 }, (_, i) => `e${i + 2}`),
      );
      expect(
        readManagedDocumentResult({ text: result.text, structure: result.structure }),
      ).not.toBeNull();
      expect(await csv(source)).toEqual(result);
    });

    it('does not infer a header, coerce numeric strings, or evaluate formula-looking text', async () => {
      const result = await csv('-000.50,001,+1.20,1e03,"=SUM(A1:A2)"\n,0,-0,,');
      const cells = result.structure.elements.filter((element) => element.kind === 'cell');
      expect(cells.map((cell) => result.text.slice(cell.start, cell.end))).toEqual([
        '-000.50',
        '001',
        '+1.20',
        '1e03',
        '=SUM(A1:A2)',
        '',
        '0',
        '-0',
        '',
        '',
      ]);
      expect(
        result.structure.elements.every(
          (element) => element.kind === 'table' || element.kind === 'cell',
        ),
      ).toBe(true);
    });

    it.each([',,', '""', '  ,"\t"\r\n ," "', '\uFEFF'])(
      'keeps wholly blank CSV as no_text: %j',
      async (value) => {
        await expect(csv(value)).rejects.toMatchObject({ code: 'no_text' });
      },
    );

    it.each(['a,b\n1', 'a,b\n1,2,3', '"unterminated', 'a"b,c', '"a"x,b', 'a,b\rc,d', 'a,\u0000'])(
      'fails malformed CSV without returning a partial table: %j',
      async (value) => {
        await expect(csv(value)).rejects.toMatchObject({ code: 'invalid_document' });
      },
    );

    it('rejects invalid UTF-8 and enforces raw-byte limits including an initial BOM', async () => {
      await expect(csv(Buffer.from([0xc3, 0x28]))).rejects.toMatchObject({
        code: 'invalid_document',
      });
      await expect(csv('x'.repeat(MANAGED_CSV_LIMITS.bytes))).resolves.toMatchObject({
        bytes: MANAGED_CSV_LIMITS.bytes,
      });
      await expect(csv('x'.repeat(MANAGED_CSV_LIMITS.bytes + 1))).rejects.toMatchObject({
        code: 'resource_limit',
      });
      await expect(csv('\uFEFF' + 'x'.repeat(MANAGED_CSV_LIMITS.bytes))).rejects.toMatchObject({
        code: 'resource_limit',
      });
      await expect(csv('éé', { inputBytes: 3 })).rejects.toMatchObject({ code: 'resource_limit' });
    });

    it.each([
      [
        'rows',
        Array.from({ length: MANAGED_CSV_LIMITS.rows }, () => 'x').join('\n'),
        Array.from({ length: MANAGED_CSV_LIMITS.rows + 1 }, () => 'x').join('\n'),
        MANAGED_CSV_LIMITS.rows,
      ],
      [
        'columns',
        Array.from({ length: MANAGED_CSV_LIMITS.columns }, () => 'x').join(','),
        Array.from({ length: MANAGED_CSV_LIMITS.columns + 1 }, () => 'x').join(','),
        MANAGED_CSV_LIMITS.columns,
      ],
      [
        'cells',
        Array.from({ length: 16 }, () => 'x,'.repeat(127) + 'x').join('\n'),
        Array.from({ length: 17 }, () => 'x,'.repeat(127) + 'x').join('\n'),
        MANAGED_CSV_LIMITS.cells,
      ],
    ])(
      'accepts exact %s ceiling and rejects excess without truncation',
      async (_name, allowed, excess, count) => {
        const result = await csv(allowed as string);
        expect(result.structure.elements).toHaveLength(Number(count) + 1);
        await expect(csv(excess as string)).rejects.toMatchObject({ code: 'resource_limit' });
      },
    );

    it('counts canonical separators and UTF-8 bytes against the native output limit', async () => {
      await expect(csv('"α",b', { outputBytes: 4 })).resolves.toMatchObject({
        text: 'α\tb',
        bytes: 4,
      });
      await expect(csv('"α",b', { outputBytes: 3 })).rejects.toMatchObject({
        code: 'resource_limit',
      });
    });
  });

  it('extracts real UTF-8 text and counts bytes rather than characters', async () => {
    await expect(text('Grüße\nαβ')).resolves.toMatchObject({ text: 'Grüße\nαβ', bytes: 12 });
  });
  it('preserves exact text and assigns stable UTF-16 paragraph ranges without invented pages', async () => {
    const input = '  Grüße 😀\r\nfortgesetzt\r\n\r\nZweiter Absatz\n';
    const result = await text(input);
    expect(result.text).toBe(input);
    expect(result).toMatchObject({
      structure: {
        version: 1,
        source: { bytes: Buffer.byteLength(input), mediaType: 'text/plain' },
        pages: [],
        elements: [
          { id: 'e1', kind: 'paragraph', start: 2, end: 23, parentId: null, page: null },
          { id: 'e2', kind: 'paragraph', start: 27, end: 41, parentId: null, page: null },
        ],
        quality: { status: 'complete', warnings: [] },
      },
    });
    expect(result.structure.source.sha256).toBe(createHash('sha256').update(input).digest('hex'));
    expect(
      readManagedDocumentResult({ text: result.text, structure: result.structure }),
    ).not.toBeNull();
    expect(await text(input)).toEqual(result);
  });
  it('keeps single CRLF line breaks inside one plain-text paragraph', async () => {
    const result = await text('first\r\nsecond\r\nthird');
    expect(result.structure.elements).toHaveLength(1);
    expect(
      result.text.slice(result.structure.elements[0].start, result.structure.elements[0].end),
    ).toBe('first\r\nsecond\r\nthird');
  });
  it.each([8000, 20_001])(
    'refuses excessive structure without silently truncating %i paragraphs',
    async (count) => {
      expect(
        await text('a\n\n'.repeat(count)).then(
          () => 'accepted',
          (error) => error.code,
        ),
      ).toBe('resource_limit');
    },
  );
  it('accepts the exact injected input boundary and rejects one extra byte', async () => {
    await expect(text('1234', { inputBytes: 4 })).resolves.toMatchObject({ text: '1234' });
    await expect(text('12345', { inputBytes: 4 })).rejects.toMatchObject({
      code: 'resource_limit',
    });
  });
  it('fails output excess without returning truncated text', async () => {
    await expect(text('αβγ', { outputBytes: 5 })).rejects.toMatchObject({ code: 'resource_limit' });
  });
  it('rejects invalid UTF-8 and an empty extraction', async () => {
    await expect(text(Buffer.from([0xc3, 0x28]))).rejects.toMatchObject({
      code: 'invalid_document',
    });
    await expect(text(' \n ')).rejects.toMatchObject({ code: 'no_text' });
  });
  it('cannot raise the production resource ceilings through parser options', async () => {
    await expect(text('ok', { inputBytes: 30 * 1024 * 1024 + 1 })).rejects.toMatchObject({
      code: 'resource_limit',
    });
  });
  it('extracts the existing real DOCX fixture usefully', async () => {
    await expect(
      extractManagedDocument({
        filePath: path.join(__dirname, 'sample.docx'),
        mediaType: MANAGED_DOCUMENT_TYPES[2],
      }),
    ).resolves.toMatchObject({ text: 'This is a sample DOCX file.\n\n' });
  });

  async function document(body: string, styles = '') {
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    );
    zip.file(
      '_rels/.rels',
      `<Relationships xmlns="${NS.package}"><Relationship Id="r1" Type="${NS.relationship}/officeDocument" Target="word/document.xml"/></Relationships>`,
    );
    zip.file(
      'word/document.xml',
      `<w:document xmlns:w="${NS.word}"><w:body>${body}</w:body></w:document>`,
    );
    if (styles) {
      zip.file('word/styles.xml', `<w:styles xmlns:w="${NS.word}">${styles}</w:styles>`);
      zip.file(
        'word/_rels/document.xml.rels',
        `<Relationships xmlns="${NS.package}"><Relationship Id="s1" Type="${NS.relationship}/styles" Target="styles.xml"/></Relationships>`,
      );
    }
    const filePath = path.join(root, 'structure.docx');
    await writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
    return extractManagedDocument({ filePath, mediaType: MANAGED_DOCUMENT_TYPES[2] });
  }
  const paragraph = (value: string) => `<w:p><w:r><w:t>${value}</w:t></w:r></w:p>`;
  it('keeps native DOCX text while recording explicit inherited headings, table spans and empty cells', async () => {
    const result = await document(
      '<w:p><w:pPr><w:pStyle w:val="CustomTitle"/></w:pPr><w:r><w:t>Titel 😀</w:t></w:r></w:p>' +
        paragraph('Absatz &amp; Inhalt') +
        '<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>' +
        paragraph('Kopf') +
        '</w:tc></w:tr><w:tr><w:tc>' +
        paragraph('Zelle α') +
        '</w:tc><w:tc>' +
        paragraph('') +
        '</w:tc></w:tr></w:tbl>',
      '<w:style w:type="paragraph" w:styleId="TitleBase"><w:name w:val="Titel"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="CustomTitle"><w:name w:val="Eigener Titel"/><w:basedOn w:val="TitleBase"/></w:style>',
    );
    expect(result.text).toBe('Titel 😀\n\nAbsatz & Inhalt\n\nKopf\n\nZelle α\n\n\n\n');
    expect(result.structure.pages).toEqual([]);
    const elements = result.structure.elements;
    expect(elements[0]).toMatchObject({ kind: 'heading', start: 0, end: 8, page: null });
    const table = elements.find((item) => item.kind === 'table')!;
    const cells = elements.filter((item) => item.kind === 'cell');
    expect(cells.map((item) => item.cell)).toEqual([
      { row: 0, column: 0, rowSpan: 1, columnSpan: 2 },
      { row: 1, column: 0, rowSpan: 1, columnSpan: 1 },
      { row: 1, column: 1, rowSpan: 1, columnSpan: 1 },
    ]);
    expect(cells.every((item) => item.parentId === table.id)).toBe(true);
    expect(cells.map((item) => result.text.slice(item.start, item.end))).toEqual([
      'Kopf\n\n',
      'Zelle α\n\n',
      '\n\n',
    ]);
    expect(result.structure.quality).toEqual({
      status: 'partial',
      warnings: ['layout_unavailable'],
    });
    expect(
      readManagedDocumentResult({ text: result.text, structure: result.structure }),
    ).not.toBeNull();
  });
  it('does not fabricate cell coordinates for unsupported vertical DOCX merges', async () => {
    const result = await document(
      paragraph('Davor') +
        '<w:tbl><w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr>' +
        paragraph('Anker') +
        '</w:tc></w:tr><w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr>' +
        paragraph('') +
        '</w:tc></w:tr></w:tbl>',
    );
    expect(result.text).toBe('Davor\n\nAnker\n\n');
    expect(result.structure.elements.some((item) => item.kind === 'cell')).toBe(false);
    expect(result.structure.quality.warnings).toContain('table_structure_unavailable');
    expect(
      readManagedDocumentResult({ text: result.text, structure: result.structure }),
    ).not.toBeNull();
  });
  it('keeps nontrivial Mammoth text but drops uncertain structure rather than guessing offsets', async () => {
    const result = await document(
      '<w:p><w:r><w:t>Check: </w:t><w:sym w:font="Wingdings" w:char="F0FC"/></w:r></w:p>',
    );
    expect(result.text).toBe('Check: ✓\n\n');
    expect(result.structure.elements).toEqual([]);
    expect(result.structure.quality.warnings).toContain('unsupported_content');
    expect(
      readManagedDocumentResult({ text: result.text, structure: result.structure }),
    ).not.toBeNull();
  });
  it('reports omitted visual content while retaining visible DOCX text', async () => {
    const result = await document(paragraph('Text') + '<w:p><w:r><w:drawing/></w:r></w:p>');
    expect(result.text).toContain('Text');
    expect(result.structure.quality.warnings).toContain('visual_content_not_extracted');
  });
  it('rejects entity definitions in structural style input too', async () => {
    await expect(
      document(paragraph('Text'), '<!DOCTYPE x [<!ENTITY x "text">]>'),
    ).rejects.toMatchObject({ code: 'invalid_document' });
  });

  async function presentation(
    options: { external?: boolean; slides?: number; extra?: number; content?: string } = {},
  ) {
    const zip = new JSZip();
    const refs = Array.from(
      { length: options.slides ?? 2 },
      (_, i) => `<p:sldId id="${256 + i}" r:id="r${i}"/>`,
    ).join('');
    zip.file(
      'ppt/presentation.xml',
      `<p:presentation xmlns:p="${NS.presentation}" xmlns:r="${NS.relationship}"><p:sldIdLst>${refs}</p:sldIdLst></p:presentation>`,
    );
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      `<Relationships xmlns="${NS.package}">${Array.from(
        { length: options.slides ?? 2 },
        (_, i) =>
          `<Relationship Id="r${i}" Type="${NS.relationship}/slide" Target="slides/slide${20 - i}.xml"${options.external ? ' TargetMode="External"' : ''}/>`,
      ).join('')}</Relationships>`,
    );
    for (let i = 0; i < (options.slides ?? 2); i++) {
      zip.file(
        `ppt/slides/slide${20 - i}.xml`,
        `<p:sld xmlns:p="${NS.presentation}" xmlns:a="${NS.drawing}">${options.content ?? `<a:p><a:r><a:t>${i === 0 ? 'First &#x3B1; &amp; topic' : 'Second β'}</a:t></a:r></a:p>`}</p:sld>`,
      );
    }
    if (options.extra) zip.file('unused.bin', Buffer.alloc(options.extra, 65));
    const filePath = path.join(root, 'presentation');
    await writeFile(
      filePath,
      await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    );
    return filePath;
  }
  it('follows declared slide relationships, not numeric filenames, and decodes XML', async () => {
    const result = await extractManagedDocument({
      filePath: await presentation(),
      mediaType: MANAGED_DOCUMENT_TYPES[3],
    });
    expect(result.text).toBe('First α & topic\n\nSecond β\n\n');
    expect(result.structure.pages).toEqual([
      { number: 1, kind: 'slide' },
      { number: 2, kind: 'slide' },
    ]);
    expect(
      result.structure.elements.map((element) => [
        element.page,
        result.text.slice(element.start, element.end),
      ]),
    ).toEqual([
      [1, 'First α & topic'],
      [2, 'Second β'],
    ]);
    expect(
      readManagedDocumentResult({ text: result.text, structure: result.structure }),
    ).not.toBeNull();
  });
  it('records native PPTX table coordinates and exact paragraphs on their declared slide', async () => {
    const filePath = await presentation({
      slides: 1,
      content:
        '<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Zelle 😀</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p/></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame><p:pic/>',
    });
    const result = await extractManagedDocument({ filePath, mediaType: MANAGED_DOCUMENT_TYPES[3] });
    expect(result.text).toBe('Zelle 😀\n\n\n');
    const table = result.structure.elements.find((item) => item.kind === 'table')!;
    const cells = result.structure.elements.filter((item) => item.kind === 'cell');
    expect(cells.map((item) => [item.page, item.parentId, item.cell])).toEqual([
      [1, table.id, { row: 0, column: 0, rowSpan: 1, columnSpan: 1 }],
      [1, table.id, { row: 0, column: 1, rowSpan: 1, columnSpan: 1 }],
    ]);
    expect(result.structure.quality.warnings).toContain('visual_content_not_extracted');
    expect(result.structure.quality.warnings).not.toContain('table_structure_unavailable');
    expect(
      readManagedDocumentResult({ text: result.text, structure: result.structure }),
    ).not.toBeNull();
    const data = await readFile(filePath);
    expect(result.structure.source).toEqual({
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      mediaType: MANAGED_DOCUMENT_TYPES[3],
    });
  });
  it('preserves PPTX text with explicit warning for unqualified merged tables', async () => {
    const result = await extractManagedDocument({
      filePath: await presentation({
        slides: 1,
        content:
          '<a:tbl><a:tr><a:tc rowSpan="2"><a:p><a:r><a:t>Oben</a:t></a:r></a:p></a:tc></a:tr></a:tbl>',
      }),
      mediaType: MANAGED_DOCUMENT_TYPES[3],
    });
    expect(result.text).toBe('Oben\n\n');
    expect(result.structure.elements.map((item) => item.kind)).toEqual(['paragraph']);
    expect(result.structure.quality.warnings).toContain('table_structure_unavailable');
  });
  it('fails too many slides instead of silently truncating the presentation', async () => {
    await expect(
      extractManagedDocument({
        filePath: await presentation(),
        mediaType: MANAGED_DOCUMENT_TYPES[3],
        limits: { pages: 1 },
      }),
    ).rejects.toMatchObject({ code: 'resource_limit' });
  });
  it('does not resolve an external slide relationship', async () => {
    await expect(
      extractManagedDocument({
        filePath: await presentation({ external: true }),
        mediaType: MANAGED_DOCUMENT_TYPES[3],
      }),
    ).rejects.toMatchObject({ code: 'invalid_document' });
  });
  it('counts actual inflation of unused parts and directories in the entry cap', async () => {
    const filePath = await presentation({ extra: 2048 });
    await expect(
      extractManagedDocument({
        filePath,
        mediaType: MANAGED_DOCUMENT_TYPES[3],
        limits: { entryBytes: 1024 },
      }),
    ).rejects.toMatchObject({ code: 'resource_limit' });
    await expect(
      extractManagedDocument({
        filePath,
        mediaType: MANAGED_DOCUMENT_TYPES[3],
        limits: { archiveEntries: 2 },
      }),
    ).rejects.toMatchObject({ code: 'resource_limit' });
  });
  it('enforces total inflation even when each unused part fits its own limit', async () => {
    const filePath = await presentation({ extra: 2048 });
    await expect(
      extractManagedDocument({
        filePath,
        mediaType: MANAGED_DOCUMENT_TYPES[3],
        limits: { inflatedBytes: 2048, entryBytes: 4096 },
      }),
    ).rejects.toMatchObject({ code: 'resource_limit' });
  });
  it('counts explicit DOCX page breaks before extracting text', async () => {
    const zip = new JSZip();
    zip.file(
      'word/document.xml',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>first page</w:t><w:br w:type="page"/><w:t>second page</w:t></w:r></w:p></w:body></w:document>',
    );
    const filePath = path.join(root, 'too-many-pages.docx');
    await writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
    await expect(
      extractManagedDocument({
        filePath,
        mediaType: MANAGED_DOCUMENT_TYPES[2],
        limits: { pages: 1 },
      }),
    ).rejects.toMatchObject({ code: 'resource_limit' });
  });
  it('rejects XML entity definitions rather than resolving them', async () => {
    const zip = new JSZip();
    zip.file(
      'ppt/presentation.xml',
      '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><x>&x;</x>',
    );
    const filePath = path.join(root, 'entity');
    await writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
    await expect(
      extractManagedDocument({ filePath, mediaType: MANAGED_DOCUMENT_TYPES[3] }),
    ).rejects.toMatchObject({ code: 'invalid_document' });
  });
  it('does not silently admit unqualified Office/OCR formats', async () => {
    await expect(
      extractManagedDocument({ filePath: path.join(root, 'unused'), mediaType: 'image/png' }),
    ).rejects.toMatchObject({ code: 'unsupported_format' });
  });

  it('extracts real PDF pages including a blank page with explicit layout and visual limitations', async () => {
    // Minimal real PDF with a complete xref, parsed by installed PDF.js; no parser/page mocks.
    const contents = ['First page', '', 'Last page'];
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      `<< /Type /Pages /Kids [${contents.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count 3 >>`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    contents.forEach((value, i) => {
      const stream = value ? `BT /F1 12 Tf 72 720 Td (${value}) Tj ET` : '';
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      );
      objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    });
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((value, i) => {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${i + 1} 0 obj\n${value}\nendobj\n`;
    });
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
    pdf += offsets
      .slice(1)
      .map((value) => `${String(value).padStart(10, '0')} 00000 n \n`)
      .join('');
    pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const filePath = path.join(root, 'pages.pdf');
    await writeFile(filePath, pdf);
    const result = await extractManagedDocument({ filePath, mediaType: 'application/pdf' });
    expect(result.structure.pages).toEqual([1, 2, 3].map((number) => ({ number, kind: 'page' })));
    expect(
      result.structure.elements.map((item) => [
        item.page,
        result.text.slice(item.start, item.end).trim(),
      ]),
    ).toEqual([
      [1, 'First page'],
      [3, 'Last page'],
    ]);
    expect(result.structure.quality).toEqual({
      status: 'partial',
      warnings: [
        'layout_unavailable',
        'visual_content_not_extracted',
        'table_structure_unavailable',
      ],
    });
    expect(
      readManagedDocumentResult({ text: result.text, structure: result.structure }),
    ).not.toBeNull();
    await expect(
      extractManagedDocument({ filePath, mediaType: 'application/pdf', limits: { pages: 2 } }),
    ).rejects.toMatchObject({ code: 'resource_limit' });
  });
});
