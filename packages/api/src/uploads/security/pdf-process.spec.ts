/** Real built PDF child, wire and observer. Only OCR is a fixed synthetic test adapter. */
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { encodeSecurityProcessRequest } from './process-wire';
import { observeSecurityProcess } from './process-observer';

const entry = resolve(__dirname, '../../../dist/uploads/security/pdf-child.cjs');
const policy = { version: 1 as const, markings: ['VS-NfD', 'GEHEIM'], labels: ['Einstufung'] };

// Same one-page synthetic PDF construction as the existing child tests; no test-module imports.
function pdf(text = 'Synthetic source', malformedImage = false, metadata?: string): Buffer {
  const drawing = malformedImage ? 'q 20 0 0 20 50 50 cm /Im1 Do Q' : '';
  const stream = `BT /F1 10 Tf 10 50 Td (${text}) Tj ET ${drawing}`;
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${metadata ? '/Metadata 6 0 R' : ''} >>`,
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 3 0 R >> ${malformedImage ? '/XObject << /Im1 6 0 R >>' : ''} >> /Contents 5 0 R >>`,
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ...(malformedImage
      ? [
          '<< /Type /XObject /Subtype /Image /Width 0 /Height 0 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 14 >>\nstream\nSYNTHETIC-DATA\nendstream',
        ]
      : []),
  ];
  if (metadata)
    objects.push(
      `<< /Type /Metadata /Subtype /XML /Length ${Buffer.byteLength(metadata)} >>\nstream\n${metadata}\nendstream`,
    );
  let content = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const offset = Buffer.byteLength(content);
  content += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  content += offsets
    .slice(1)
    .map((value) => `${String(value).padStart(10, '0')} 00000 n \n`)
    .join('');
  content += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  return Buffer.from(content);
}

function identity(pid: number) {
  const fields = readFileSync(`/proc/${pid}/stat`, 'utf8')
    .split(')')
    .slice(1)
    .join(')')
    .trim()
    .split(/\s+/);
  return { pid, startTicks: fields[19], processGroup: Number(fields[2]), state: fields[0] };
}

async function run(bytes: Buffer, fakeOcr = false, expectedPages = 1) {
  const request = encodeSecurityProcessRequest({ mediaType: 'application/pdf', policy, bytes });
  const args = [entry];
  const pages: Uint8ClampedArray[] = [];
  const ocr = {
    readPage: jest.fn(
      async ({
        page,
        width,
        height,
        rgba,
      }: Parameters<import('./pdf').PdfSecurityOcr['readPage']>[0]) => {
        expect(page).toBe(1);
        expect(width).toBe(400);
        expect(height).toBe(200);
        expect(rgba.length).toBe(320000);
        expect(rgba.some((value, index) => index % 4 !== 3 && value < 128)).toBe(true);
        pages.push(rgba);
        return { complete: true, readable: true, text: '' };
      },
    ),
  };
  const child = spawn(process.execPath, args, {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    env: { NODE_ENV: 'test', LANG: 'C.UTF-8' },
  });
  const ignoreSpawnError = () => undefined;
  child.on('error', ignoreSpawnError);
  const joined = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let deadlineExceeded = false;
  const deadline = setTimeout(() => {
    deadlineExceeded = true;
    child.kill('SIGKILL');
  }, 8000);
  let actor: ReturnType<typeof identity> | undefined;
  let result: Awaited<ReturnType<typeof observeSecurityProcess>>;
  try {
    actor = child.pid ? identity(child.pid) : undefined;
    if (process.env.SECURITY_PROCESS_PROVENANCE_PATH) {
      if (
        !process.env.SECURITY_PROCESS_SESSION ||
        !process.env.SECURITY_PROCESS_LEASE ||
        !process.env.SECURITY_PROCESS_OWNER
      )
        throw new Error('PDF test provenance is incomplete');
      appendFileSync(
        process.env.SECURITY_PROCESS_PROVENANCE_PATH,
        JSON.stringify({
          repository: process.cwd(),
          session: process.env.SECURITY_PROCESS_SESSION,
          lease: process.env.SECURITY_PROCESS_LEASE,
          owner: process.env.SECURITY_PROCESS_OWNER,
          scope: 'security-process-composition',
          bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
          ...actor,
          command: [process.execPath, ...args],
          at: new Date().toISOString(),
          cancellation:
            'Own ChildProcess handle only; observer 6s plus bounded cleanup, parent deadline 8s and close join',
        }) + '\n',
      );
    }
    result = await observeSecurityProcess({
      child,
      request,
      signal: new AbortController().signal,
      timeoutMs: 6000,
      ...(fakeOcr ? { ocr } : {}),
    });
    await joined;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await joined;
    clearTimeout(deadline);
    child.removeListener('error', ignoreSpawnError);
    request.fill(0);
    bytes.fill(0);
  }
  if (actor) {
    let remaining: ReturnType<typeof identity> | undefined;
    try {
      remaining = identity(actor.pid);
    } catch {
      remaining = undefined;
    }
    if (remaining?.startTicks === actor.startTicks && remaining.state !== 'Z') {
      throw new Error('Owned PDF child did not stop');
    }
  }
  if (deadlineExceeded) throw new Error('Synthetic PDF child exceeded its parent deadline');
  if (fakeOcr) expect(ocr.readPage).toHaveBeenCalledTimes(expectedPages);
  expect(pages.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  return result;
}

describe('actual private PDF child and observer composition', () => {
  beforeAll(() => {
    if (!existsSync(entry))
      throw new Error('Build @librechat/api before its process integration tests');
  });

  it('refuses the actual page frame when no trusted OCR broker is supplied', async () => {
    expect(await run(pdf())).toEqual({
      result: null,
      pages: 0,
      localCopiesRemoved: true,
      diagnostics: false,
      directChildStopped: true,
      transportComplete: false,
    });
  });

  it('observes real PDF parsing and rendering with a fixed quiet synthetic OCR adapter', async () => {
    expect(await run(pdf(), true)).toEqual({
      result: { decision: 'clear', coverage: { complete: true, pages: 1, parts: 1 } },
      pages: 1,
      localCopiesRemoved: true,
      diagnostics: false,
      directChildStopped: true,
      transportComplete: true,
    });
  });

  it('delivers a quiet strict-image rejection through the actual observer after the child stops', async () => {
    expect(await run(pdf('Synthetic source', true), true, 0)).toEqual({
      result: { decision: 'uninspectable', reason: 'invalid_content' },
      pages: 0,
      localCopiesRemoved: true,
      diagnostics: false,
      directChildStopped: true,
      transportComplete: true,
    });
  });

  it.each(['Synthetic title', 'GEHEIM'])(
    'checks validated native catalog metadata including %s through the built process',
    async (title) => {
      const metadata =
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>' +
        title +
        '</dc:title></rdf:Description></rdf:RDF></x:xmpmeta>';
      expect(await run(pdf('Synthetic source', false, metadata), true)).toEqual({
        result:
          title === 'GEHEIM'
            ? { decision: 'uninspectable', reason: 'ambiguous_marking' }
            : { decision: 'clear', coverage: { complete: true, pages: 1, parts: 1 } },
        pages: 1,
        localCopiesRemoved: true,
        diagnostics: false,
        directChildStopped: true,
        transportComplete: true,
      });
    },
  );

  it('preserves a real native synthetic classification rejection', async () => {
    expect(await run(pdf('Einstufung: GEHEIM'), true)).toEqual({
      result: { decision: 'rejected', reason: 'classification_marking' },
      pages: 1,
      localCopiesRemoved: true,
      diagnostics: false,
      directChildStopped: true,
      transportComplete: true,
    });
  });
});
