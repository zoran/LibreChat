/** Real tolerant/strict PDF.js witness and strict consumer; neither grants document approval. */
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const marking = 'Einstufung: GEHEIM';
const text = 'Synthetic benign page';
const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:description><rdf:Alt><rdf:li xml:lang="x-default">${marking}</rdf:li></rdf:Alt></dc:description></rdf:Description></rdf:RDF></x:xmpmeta>`;

// Byte-accurate synthetic construction follows pdf.spec.ts; this is not a PDF parser.
function pdf(subtype: 'XML' | 'Bogus' | null): Buffer {
  const stream = `0 0 0 rg 10 10 20 20 re f BT /F1 10 Tf 10 50 Td (${text}) Tj ET`;
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${subtype ? '/Metadata 6 0 R' : ''} >>`,
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ...(subtype
      ? [
          `<< /Type /Metadata /Subtype /${subtype} /Length ${Buffer.byteLength(xmp)} >>\nstream\n${xmp}\nendstream`,
        ]
      : []),
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const offset = Buffer.byteLength(source);
  source += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map((value) => `${String(value).padStart(10, '0')} 00000 n \n`)
    .join('');
  source += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  return Buffer.from(source);
}

// Use the installed runtime and ts-node to load actual adapter source without a product build.
// fd3 carries test observations; stdout/stderr remain untouched real parser diagnostics.
const nativeProbe = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const consumerRequire = require('node:module').createRequire(process.argv[1]);
const fields = fs.readFileSync('/proc/self/stat', 'utf8').split(')').slice(1).join(')').trim().split(/\s+/);
const actor = {
  repository: process.cwd(), session: process.env.SECURITY_PROCESS_SESSION,
  lease: process.env.SECURITY_PROCESS_LEASE, owner: process.env.SECURITY_PROCESS_OWNER,
  scope: 'native-pdf-metadata-coverage-witness', pid: process.pid,
  startTicks: fields[19], processGroup: Number(fields[2]),
  bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
};
if (process.env.SECURITY_PROCESS_PROVENANCE_PATH) {
  if (!actor.session || !actor.lease || !actor.owner) throw new Error('PDF test provenance is incomplete');
  fs.appendFileSync(process.env.SECURITY_PROCESS_PROVENANCE_PATH,
    JSON.stringify({ ...actor, status: 'started', at: new Date().toISOString() }) + '\n');
}
setTimeout(() => process.exit(90), 7000).unref();
require('ts-node').register({ transpileOnly: true, skipProject: true,
  compilerOptions: { module: 'CommonJS', moduleResolution: 'Node', target: 'ES2022', esModuleInterop: true } });
async function main() {
  const bytes = fs.readFileSync(0);
  const { getDocument, VerbosityLevel, version } = consumerRequire('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = consumerRequire('@napi-rs/canvas');
  const { inspectPdfSecurity } = require(process.argv[1]);
  const loading = getDocument({ data: new Uint8Array(bytes), verbosity: VerbosityLevel.WARNINGS,
    isEvalSupported: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false,
    disableAutoFetch: true, disableRange: true, disableStream: true, stopAtErrors: true,
    enableXfa: false, isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    maxImageSize: 8000000, canvasMaxAreaInBytes: 32000000,
    standardFontDataUrl: path.join(path.dirname(consumerRequire.resolve('pdfjs-dist/package.json')), 'standard_fonts') + '/',
  });
  let observation;
  try {
    const document = await loading.promise;
    const metadataResult = await document.getMetadata();
    const { info, metadata } = metadataResult;
    const page = await document.getPage(1);
    const content = await page.getTextContent({ disableNormalization: true });
    const viewport = page.getViewport({ scale: 2 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    try {
      const context = canvas.getContext('2d');
      await page.render({ canvas: null, canvasContext: context, viewport,
        intent: 'print', background: 'rgb(255,255,255)' }).promise;
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
      observation = { version, inputBytes: bytes.length,
        inputSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        pages: document.numPages, info, metadataRaw: metadata?.getRaw() ?? null,
        defaultMetadataEvidence: Object.hasOwn(metadataResult, 'metadataInspection'),
        metadataDescription: metadata?.get('dc:description') ?? null,
        nativeText: content.items.map(item => item.str).join(' '),
        render: { width: canvas.width, height: canvas.height, bytes: rgba.length,
          ink: rgba.some((value, index) => index % 4 !== 3 && value < 128),
          sha256: crypto.createHash('sha256').update(rgba).digest('hex') } };
      rgba.fill(0);
    } finally { canvas.width = 0; canvas.height = 0; page.cleanup(); }
  } finally { await loading.destroy(); }
  const strictLoading = getDocument({ data: new Uint8Array(bytes), strictMetadata: true,
    isEvalSupported: false, verbosity: VerbosityLevel.WARNINGS });
  try {
    const document = await strictLoading.promise;
    const { metadata, metadataInspection } = await document.getMetadata();
    observation.strictMetadataInspection = metadataInspection;
    observation.strictMetadataRaw = metadata?.getRaw() ?? null;
  } finally { await strictLoading.destroy(); }
  const ocrPages = [];
  const result = await inspectPdfSecurity({ bytes, mediaType: 'application/pdf',
    policy: { version: 1, markings: ['VS-NfD', 'GEHEIM'], labels: ['Einstufung'] },
    ocr: { readPage: async ({ page, width, height, rgba }) => {
      ocrPages.push({ page, width, height, bytes: rgba.length,
        ink: rgba.some((value, index) => index % 4 !== 3 && value < 128) });
      return { complete: true, readable: true, text: '' };
    } },
  });
  fs.writeFileSync(3, JSON.stringify({ ...observation, result, ocrPages }));
  bytes.fill(0);
}
main().catch(error => { console.error(error); process.exitCode = 91; });
`;

type Observation = {
  version: string;
  inputBytes: number;
  inputSha256: string;
  pages: number;
  info: Record<string, unknown>;
  metadataRaw: string | null;
  metadataDescription: string | null;
  defaultMetadataEvidence: boolean;
  strictMetadataInspection: unknown;
  strictMetadataRaw: string | null;
  nativeText: string;
  render: { width: number; height: number; bytes: number; ink: boolean; sha256: string };
  result: { decision: string; reason: string };
  ocrPages: { page: number; width: number; height: number; bytes: number; ink: boolean }[];
};

async function probe(bytes: Buffer) {
  const cwd = resolve(__dirname, '../../../../..');
  const child = spawn(process.execPath, ['-e', nativeProbe, resolve(__dirname, 'pdf.ts')], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    env: {
      NODE_ENV: 'test',
      LANG: 'C.UTF-8',
      TMPDIR: process.env.TMPDIR,
      SECURITY_PROCESS_SESSION: process.env.SECURITY_PROCESS_SESSION,
      SECURITY_PROCESS_LEASE: process.env.SECURITY_PROCESS_LEASE,
      SECURITY_PROCESS_OWNER: process.env.SECURITY_PROCESS_OWNER,
      SECURITY_PROCESS_PROVENANCE_PATH: process.env.SECURITY_PROCESS_PROVENANCE_PATH,
    },
  });
  const output: Buffer[][] = [[], [], []];
  let outputBytes = 0;
  let overflow = false;
  for (const [index, stream] of child.stdio.slice(1).entries()) {
    stream?.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 64 * 1024) {
        overflow = true;
        child.kill('SIGKILL');
      } else output[index].push(chunk);
    });
  }
  const closed = new Promise<number | null>((done, fail) => {
    child.once('error', fail);
    child.once('close', done);
  });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 8000);
  try {
    if (child.pid === undefined) throw new Error('Native PDF witness did not spawn');
    const fields = readFileSync(`/proc/${child.pid}/stat`, 'utf8')
      .split(')')
      .slice(1)
      .join(')')
      .trim()
      .split(/\s+/);
    const actor = {
      repository: cwd,
      session: process.env.SECURITY_PROCESS_SESSION,
      lease: process.env.SECURITY_PROCESS_LEASE,
      owner: process.env.SECURITY_PROCESS_OWNER,
      scope: 'native-pdf-metadata-coverage-witness',
      pid: child.pid,
      startTicks: fields[19],
      processGroup: Number(fields[2]),
      bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
      status: 'started',
    };
    expect(Number.isSafeInteger(actor.pid) && actor.pid > 0).toBe(true);
    expect(actor.startTicks).toMatch(/^[1-9]\d*$/);
    expect(Number.isSafeInteger(actor.processGroup) && actor.processGroup > 0).toBe(true);
    expect(actor.bootId).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
    if (process.env.SECURITY_PROCESS_PROVENANCE_PATH) {
      for (const value of [actor.session, actor.lease, actor.owner]) {
        expect(typeof value === 'string' && value.length > 0).toBe(true);
      }
    }
    child.stdin?.end(bytes);
    const code = await closed;
    const [stdout, stderr, result] = output.map((chunks) => Buffer.concat(chunks));
    expect({ code, overflow, stdout: stdout.toString(), stderr: stderr.toString() }).toEqual({
      code: 0,
      overflow: false,
      stdout: '',
      stderr: '',
    });
    return {
      ...(JSON.parse(result.toString()) as Observation),
      actor,
      diagnostics: { stdoutBytes: stdout.length, stderrBytes: stderr.length, boundBytes: 65536 },
    };
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
}

it('preserves tolerant metadata observations while the strict consumer refuses omitted metadata before OCR', async () => {
  const observations = [];
  const expectedMetadata = {
    XML: { status: 'validated', decodedBytes: Buffer.byteLength(xmp) },
    Bogus: { status: 'refused', reason: 'invalid_stream' },
    absent: { status: 'absent' },
  };
  for (const subtype of ['XML', 'Bogus', null] as const) {
    const bytes = pdf(subtype);
    expect(bytes.includes(Buffer.from(marking))).toBe(subtype !== null);
    const result = await probe(bytes);
    expect(result.version).toBe('5.4.624-cortex.metadata.2');
    expect(result.defaultMetadataEvidence).toBe(false);
    expect(result.inputBytes).toBe(bytes.length);
    expect(result.pages).toBe(1);
    expect(result.nativeText).toBe(text);
    expect(result.render).toMatchObject({ width: 400, height: 200, bytes: 320000, ink: true });
    expect(result.ocrPages).toEqual(
      subtype === 'Bogus' ? [] : [{ page: 1, width: 400, height: 200, bytes: 320000, ink: true }],
    );
    expect(result.strictMetadataInspection).toEqual({
      version: 1,
      scope: 'catalog-metadata',
      documentComplete: false,
      ...expectedMetadata[subtype ?? 'absent'],
    });
    expect(result.strictMetadataRaw).toBe(subtype === 'XML' ? xmp : null);
    expect(JSON.stringify(result.info)).not.toContain(marking);
    if (subtype === 'XML') {
      expect(result.metadataRaw).toContain(marking);
      expect(result.metadataDescription).toContain(marking);
      // The existing adapter inspects raw XML and conservatively treats its marking as ambiguous.
      expect(result.result).toEqual({ decision: 'uninspectable', reason: 'ambiguous_marking' });
    } else {
      expect(result.metadataRaw).toBeNull();
      expect(result.metadataDescription).toBeNull();
      expect(result.result).toEqual({ decision: 'uninspectable', reason: 'incomplete_coverage' });
    }
    observations.push({ subtype, ...result });
  }
  expect(new Set(observations.map((result) => result.render.sha256)).size).toBe(1);
  if (process.env.PDF_METADATA_EVIDENCE_PATH) {
    writeFileSync(process.env.PDF_METADATA_EVIDENCE_PATH, JSON.stringify(observations, null, 2));
  }
  if (process.env.SECURITY_PROCESS_PROVENANCE_PATH) {
    const records = readFileSync(process.env.SECURITY_PROCESS_PROVENANCE_PATH, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const actors = observations.map(({ actor }) => actor);
    expect(actors).toHaveLength(3);
    expect(new Set(actors.map(({ pid }) => pid)).size).toBe(3);
    for (const actor of actors) {
      const matching = records.filter((record) => record?.pid === actor.pid);
      expect(matching).toHaveLength(1);
      expect(matching[0]).toMatchObject(actor);
      let current: string | undefined;
      try {
        current = readFileSync(`/proc/${actor.pid}/stat`, 'utf8');
      } catch {
        current = undefined;
      }
      expect(current?.split(')').slice(1).join(')').trim().split(/\s+/)[19]).not.toBe(
        actor.startTicks,
      );
    }
  }
}, 20000);
