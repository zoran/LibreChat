import JSZip from 'jszip';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { extractManagedDocument, MANAGED_DOCUMENT_TYPES } from './managed';

const NS = {
  presentation: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  drawing: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  relationship: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  package: 'http://schemas.openxmlformats.org/package/2006/relationships',
};

describe('managed useful extraction and hard limits', () => {
  let root: string;
  beforeAll(async () => {
    if (!process.env.UPLOAD_TEST_TMPDIR)
      throw new Error('Explicit isolated upload test directory required');
    await mkdir(process.env.UPLOAD_TEST_TMPDIR, { recursive: true });
    root = await mkdtemp(path.join(process.env.UPLOAD_TEST_TMPDIR, 'documents-'));
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function text(data: Buffer | string, limits = {}) {
    const filePath = path.join(root, 'original');
    await writeFile(filePath, data);
    return extractManagedDocument({ filePath, mediaType: 'text/plain', limits });
  }

  it('extracts real UTF-8 text and counts bytes rather than characters', async () => {
    await expect(text('Grüße\nαβ')).resolves.toEqual({ text: 'Grüße\nαβ', bytes: 12 });
  });
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

  async function presentation(
    options: { external?: boolean; slides?: number; extra?: number } = {},
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
        `<p:sld xmlns:p="${NS.presentation}" xmlns:a="${NS.drawing}"><a:p><a:r><a:t>${i === 0 ? 'First &#x3B1; &amp; topic' : 'Second β'}</a:t></a:r></a:p></p:sld>`,
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
});
