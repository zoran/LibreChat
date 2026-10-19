/** Real installed PDF.js and native Canvas; only OCR is an explicit synthetic adapter. */
import { createHash } from 'node:crypto';
import type { PdfSecurityInput, PdfSecurityOcr } from './pdf';
import { inspectPdfSecurity, PDF_SECURITY_LIMITS } from './pdf';

// The existing CommonJS Jest harness delegates ESM/native loading to real Node, not fake parsers.
jest.mock('pdfjs-dist/legacy/build/pdf.mjs', () =>
  process.getBuiltinModule('module').createRequire(__filename)('pdfjs-dist/legacy/build/pdf.mjs'),
);
jest.mock('@napi-rs/canvas', () =>
  process.getBuiltinModule('module').createRequire(__filename)('@napi-rs/canvas'),
);
const policy = { version: 1 as const, markings: ['VS-NfD', 'GEHEIM'], labels: ['Einstufung'] };
const incomplete = { decision: 'uninspectable', reason: 'incomplete_coverage' };
const invalid = { decision: 'uninspectable', reason: 'invalid_content' };
const limited = { decision: 'uninspectable', reason: 'resource_limit' };
const rejected = { decision: 'rejected', reason: 'classification_marking' };

function assemble(objects: string[], trailer = '') {
  let source = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(source, 'latin1'));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const offset = Buffer.byteLength(source, 'latin1');
  source += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join('');
  source += `trailer\n<< /Size ${offsets.length} /Root 1 0 R ${trailer} >>\nstartxref\n${offset}\n%%EOF\n`;
  return Buffer.from(source, 'latin1');
}
function pdf(
  contents = ['Synthetic page'],
  options: {
    catalog?: string;
    resources?: string;
    drawing?: string;
    page?: string;
    extra?: string[];
    trailer?: string;
    transform?: (content: Buffer, object: number) => Buffer;
  } = {},
) {
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${options.catalog ?? ''} >>`,
    `<< /Type /Pages /Kids [${contents.map((_, n) => `${4 + n * 2} 0 R`).join(' ')}] /Count ${contents.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  contents.forEach((text, n) => {
    const value = text.replace(/([()\\])/gu, '\\$1');
    const stream = Buffer.from(
      `0 0 0 rg 10 10 20 20 re f BT /F1 10 Tf 10 50 Td (${value}) Tj ET ${options.drawing ?? ''}`,
      'latin1',
    );
    const encoded = options.transform?.(stream, 5 + n * 2) ?? stream;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 3 0 R >> ${options.resources ?? ''} >> /Contents ${5 + n * 2} 0 R ${options.page ?? ''} >>`,
      `<< /Length ${encoded.length} >>\nstream\n${encoded.toString('latin1')}\nendstream`,
    );
  });
  return assemble([...objects, ...(options.extra ?? [])], options.trailer);
}
const fakeOcr = (text = ''): PdfSecurityOcr => ({
  readPage: jest.fn(async () => ({ complete: true, readable: true, text })),
});
const inspect = (bytes: Uint8Array = pdf(), extra: Partial<PdfSecurityInput> = {}) =>
  inspectPdfSecurity({ bytes, mediaType: 'application/pdf', policy, ocr: fakeOcr(), ...extra });

function metadata(xml: string, subtype = 'XML') {
  return {
    catalog: '/Metadata 6 0 R',
    extra: [
      `<< /Type /Metadata /Subtype /${subtype} /Length ${Buffer.byteLength(xml)} >>\nstream\n${xml}\nendstream`,
    ],
  };
}
const xmp =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/">' +
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description rdf:about="" /></rdf:RDF></x:xmpmeta>';

// Real Standard/R2 encryption with an empty user password: PDF.js can open it without prompting.
function encryptedPdf() {
  const pad = Buffer.from(
    '28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a',
    'hex',
  );
  const md5 = (...values: Buffer[]) => createHash('md5').update(Buffer.concat(values)).digest();
  const rc4 = (key: Buffer, value: Buffer) => {
    const state = Array.from({ length: 256 }, (_, n) => n);
    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + state[i] + key[i % key.length]) % 256;
      [state[i], state[j]] = [state[j], state[i]];
    }
    let i = 0;
    j = 0;
    return Buffer.from(
      value.map((byte) => {
        i = (i + 1) % 256;
        j = (j + state[i]) % 256;
        [state[i], state[j]] = [state[j], state[i]];
        return byte ^ state[(state[i] + state[j]) % 256];
      }),
    );
  };
  const owner = rc4(md5(pad).subarray(0, 5), pad);
  const permissions = Buffer.from('fcffffff', 'hex');
  const id = Buffer.alloc(16, 1);
  const key = md5(pad, owner, permissions, id).subarray(0, 5);
  const user = rc4(key, pad);
  return pdf(['Encrypted synthetic page'], {
    extra: [
      `<< /Filter /Standard /V 1 /R 2 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P -4 >>`,
    ],
    trailer: `/Encrypt 6 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>]`,
    transform: (content, object) =>
      rc4(md5(key, Buffer.from([object, 0, 0, 0, 0])).subarray(0, 10), content),
  });
}

describe('bounded PDF security inspection with explicit fake OCR', () => {
  it('really rasterizes every page and emits complete evidence for the independent process owner', async () => {
    const original = pdf(['First synthetic page', '', 'Last synthetic page'], {
      page: '/Rotate 90',
    });
    const before = Buffer.from(original);
    const seen: number[] = [];
    const buffers: Uint8ClampedArray[] = [];
    let active = 0;
    const ocr: PdfSecurityOcr = {
      readPage: jest.fn(async (image) => {
        expect(++active).toBe(1);
        expect(image.width).toBe(200);
        expect(image.height).toBe(400);
        expect(image.rgba.length).toBe(200 * 400 * 4);
        expect(image.rgba.some((byte, index) => index % 4 !== 3 && byte < 128)).toBe(true);
        expect(image.rgba.some((byte, index) => index % 4 !== 3 && byte === 255)).toBe(true);
        seen.push(image.page);
        buffers.push(image.rgba);
        await Promise.resolve();
        active--;
        return { complete: true, readable: true, text: '' };
      }),
    };
    expect(await inspect(original, { ocr })).toEqual({
      decision: 'clear',
      coverage: { complete: true, pages: 3, parts: 1 },
    });
    expect(seen).toEqual([1, 2, 3]);
    expect(original).toEqual(before);
    expect(buffers.every((pixels) => pixels.every((byte) => byte === 0))).toBe(true);
  });

  it('never clears native text without OCR and never accepts partial or unreadable OCR', async () => {
    expect(await inspect(pdf(), { ocr: undefined })).toEqual(incomplete);
    for (const response of [
      { complete: false, readable: true, text: 'Partial' },
      { complete: true, readable: false, text: '' },
    ]) {
      expect(await inspect(pdf(), { ocr: { readPage: jest.fn(async () => response) } })).toEqual(
        incomplete,
      );
    }
  });

  it('includes native later-page text, metadata and every OCR result in the real policy', async () => {
    expect(await inspect(pdf(['Synthetic first page', 'Einstufung: GEHEIM']))).toEqual(rejected);
    expect(
      await inspect(
        pdf(['Synthetic page'], { extra: ['<< /Title (GEHEIM) >>'], trailer: '/Info 6 0 R' }),
      ),
    ).toEqual(rejected);
    const ocr: PdfSecurityOcr = {
      readPage: jest.fn(async ({ page }) => ({
        complete: true,
        readable: true,
        text: page === 2 ? 'Einstufung: VS-NfD' : '',
      })),
    };
    expect(await inspect(pdf(['', '']), { ocr })).toEqual(rejected);
  });

  it.each([
    ['JavaScript', { catalog: '/OpenAction << /S /JavaScript /JS (app.alert(1)) >>' }],
    ['page actions', { page: '/AA << /O << /S /JavaScript /JS (app.alert(1)) >> >>' }],
    [
      'annotation',
      {
        page: '/Annots [6 0 R]',
        extra: ['<< /Type /Annot /Subtype /Text /Rect [0 0 10 10] /Contents (Note) >>'],
      },
    ],
    [
      'optional content',
      {
        catalog: '/OCProperties << /OCGs [6 0 R] /D << /Order [6 0 R] /ON [6 0 R] >> >>',
        extra: ['<< /Type /OCG /Name (Hidden) >>'],
      },
    ],
    [
      'XFA',
      {
        catalog: '/AcroForm << /XFA 6 0 R /Fields [] >>',
        extra: ['<< /Length 7 >>\nstream\n<xdp />\nendstream'],
      },
    ],
    [
      'attachment',
      {
        catalog: '/Names << /EmbeddedFiles << /Names [(test.txt) 6 0 R] >> >>',
        extra: [
          '<< /Type /Filespec /F (test.txt) /EF << /F 7 0 R >> >>',
          '<< /Type /EmbeddedFile /Length 4 >>\nstream\ntest\nendstream',
        ],
      },
    ],
  ] as const)('fails closed for unchecked %s before OCR', async (_name, options) => {
    const ocr = fakeOcr();
    expect(
      (
        await inspect(
          pdf(['Synthetic'], { ...options, extra: 'extra' in options ? [...options.extra] : [] }),
          { ocr },
        )
      ).decision,
    ).toBe('uninspectable');
    expect(ocr.readPage).not.toHaveBeenCalled();
  });

  it('handles absent catalog metadata without treating parser evidence as document approval', async () => {
    // Validated metadata crosses native Map realms in this Jest bridge; its positive
    // and marking acceptance live in pdf-process.spec.ts through the actual built child.
    for (const options of [{}]) {
      const ocr = fakeOcr();
      expect(await inspect(pdf(['Synthetic page'], options), { ocr })).toEqual({
        decision: 'clear',
        coverage: { complete: true, pages: 1, parts: 1 },
      });
      expect(ocr.readPage).toHaveBeenCalledTimes(1);
    }
  });

  it('stops refused catalog metadata before pages or OCR and preserves the resource-limit reason', async () => {
    for (const [options, expected] of [
      [{ catalog: '/Metadata null' }, incomplete],
      [metadata(xmp, 'Bogus'), incomplete],
      [metadata('<broken>'), incomplete],
      [metadata('x'.repeat(65_537)), limited],
    ] as const) {
      const ocr = fakeOcr();
      expect(await inspect(pdf(['Synthetic page'], options), { ocr })).toEqual(expected);
      expect(ocr.readPage).not.toHaveBeenCalled();
    }
  });

  it('requires compatible metadata evidence even if a dependency drops or changes the native result', async () => {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({ data: new Uint8Array(pdf()), isEvalSupported: false });
    try {
      const document = await loading.promise;
      const prototype = Object.getPrototypeOf(document) as Pick<typeof document, 'getMetadata'>;
      const original = prototype.getMetadata;
      const absent = {
        version: 1,
        scope: 'catalog-metadata',
        documentComplete: false,
        status: 'absent',
      };
      for (const value of [
        undefined,
        { ...absent, version: 2 },
        { ...absent, scope: 'other' },
        { ...absent, documentComplete: true },
        { ...absent, status: 'unknown' },
        { ...absent, status: 'validated', decodedBytes: 1 },
      ]) {
        // Deliberate dependency-boundary corruption; parsing still uses the real document.
        const changed = jest.spyOn(prototype, 'getMetadata').mockImplementation(async function (
          this: typeof document,
        ) {
          return { ...(await original.call(this)), metadataInspection: value } as Awaited<
            ReturnType<typeof original>
          >;
        });
        try {
          const ocr = fakeOcr();
          expect(await inspect(pdf(), { ocr })).toEqual(incomplete);
          expect(ocr.readPage).not.toHaveBeenCalled();
        } finally {
          changed.mockRestore();
        }
      }
    } finally {
      await loading.destroy();
    }
  });

  it.each([
    ['zero dimensions', 1, '/Width 0 /Height 0', 'VS-NfD testdata'],
    ['asynchronous shared image decoding', 3, '/Width 1 /Height 1 /Filter /DCTDecode', 'NOTAJPEG'],
  ] as const)(
    'rejects %s before OCR through the actual strict renderer',
    async (_name, pages, dimensions, bytes) => {
      const ocr = fakeOcr();
      const source = pdf(
        Array.from({ length: pages }, () => 'Synthetic page'),
        {
          resources: `/XObject << /Im1 ${4 + pages * 2} 0 R >>`,
          drawing: 'q 20 0 0 20 50 50 cm /Im1 Do /Im1 Do Q',
          extra: [
            `<< /Type /XObject /Subtype /Image ${dimensions} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${Buffer.byteLength(bytes)} >>\nstream\n${bytes}\nendstream`,
          ],
        },
      );
      expect(await inspect(source, { ocr })).toEqual(invalid);
      expect(ocr.readPage).not.toHaveBeenCalled();
    },
  );

  it('rejects a real encrypted PDF even when its empty password lets PDF.js open it', async () => {
    const ocr = fakeOcr();
    const bytes = encryptedPdf();
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false });
    try {
      const document = await loading.promise;
      expect((await document.getMetadata()).info).toMatchObject({ EncryptFilterName: 'Standard' });
    } finally {
      await loading.destroy();
    }
    expect(await inspect(bytes, { ocr })).toEqual(incomplete);
    expect(ocr.readPage).not.toHaveBeenCalled();
  });

  it('bounds bytes, pages, pixels, combined text and per-page OCR output', async () => {
    expect(await inspect(new Uint8Array(PDF_SECURITY_LIMITS.bytes + 1))).toEqual(limited);
    expect(await inspect(pdf(['One', 'Two']), { limits: { pages: 1 } })).toEqual(limited);
    expect(await inspect(pdf(), { limits: { pagePixels: 10 } })).toEqual(limited);
    expect(await inspect(pdf(['One', 'Two']), { limits: { totalPixels: 100_000 } })).toEqual(
      limited,
    );
    expect(await inspect(pdf(), { ocr: fakeOcr('x'.repeat(65_537)) })).toEqual(limited);
    expect(await inspect(pdf(), { limits: { outputBytes: 1 } })).toEqual(limited);
    expect(await inspect(pdf(), { limits: { bytes: PDF_SECURITY_LIMITS.bytes + 1 } })).toEqual(
      limited,
    );
  });

  it('fails closed on corrupt input, cancellation and a non-completing OCR port', async () => {
    expect((await inspect(Buffer.from('%PDF-1.4\nbroken'))).decision).toBe('uninspectable');
    const controller = new AbortController();
    controller.abort();
    const ocr = fakeOcr();
    expect(await inspect(pdf(), { signal: controller.signal, ocr })).toEqual(incomplete);
    expect(ocr.readPage).not.toHaveBeenCalled();
    expect(
      await inspect(pdf(), {
        limits: { timeoutMs: 250 },
        ocr: { readPage: () => new Promise(() => undefined) },
      }),
    ).toEqual(limited);
  });
});
