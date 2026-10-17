/** Real built PDF child, wire and observer. Only OCR is a fixed synthetic test adapter. */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { observeSecurityProcess } from './process-observer';
import { encodeSecurityProcessRequest } from './process-wire';

const entry = resolve(__dirname, '../../../dist/uploads/security/pdf-child.cjs');
const policy = { version: 1 as const, markings: ['VS-NfD', 'GEHEIM'], labels: ['Einstufung'] };
const incomplete = { decision: 'uninspectable', reason: 'incomplete_coverage' };

// Same one-page synthetic PDF construction as the existing child tests; no test-module imports.
function pdf(text = 'Synthetic source', malformedImage = false): Buffer {
  const drawing = malformedImage ? 'q 20 0 0 20 50 50 cm /Im1 Do Q' : '';
  const stream = `BT /F1 10 Tf 10 50 Td (${text}) Tj ET ${drawing}`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
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

// Fixed test-only adapter. Its quiet exit witness requires an actual rendered page and ink.
// No command, path, OCR selection or expected result comes from the request.
const fakeOcrFixture = `
setTimeout(()=>process.exit(90),7000).unref();
const { runPdfSecurityChild } = require(process.argv[1]);
let calls = 0, rendered = false;
runPdfSecurityChild({ readPage: async ({ page, width, height, rgba }) => {
  calls++;
  rendered = page === 1 && width === 400 && height === 200 && rgba.length === 320000 &&
    rgba.some((value,index)=>index % 4 !== 3 && value < 128);
  return { complete: true, readable: true, text: '' };
}}).then(() => {
  if (calls !== 1 || !rendered) process.exitCode = 91;
}, () => { process.exitCode = 92; });
`;

function identity(pid: number) {
  const fields = readFileSync(`/proc/${pid}/stat`, 'utf8')
    .split(')')
    .slice(1)
    .join(')')
    .trim()
    .split(/\s+/);
  return { pid, startTicks: fields[19], processGroup: Number(fields[2]), state: fields[0] };
}

async function run(bytes: Buffer, fakeOcr = false) {
  const request = encodeSecurityProcessRequest({ mediaType: 'application/pdf', policy, bytes });
  const args = fakeOcr ? ['-e', fakeOcrFixture, entry] : [entry];
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
      appendFileSync(
        process.env.SECURITY_PROCESS_PROVENANCE_PATH,
        JSON.stringify({
          repository: process.cwd(),
          session: process.env.SECURITY_PROCESS_SESSION,
          lease: process.env.SECURITY_PROCESS_LEASE,
          owner: '/root/workspace_sources',
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
  return result;
}

describe('actual private PDF child and observer composition', () => {
  beforeAll(() => {
    if (!existsSync(entry))
      throw new Error('Build @librechat/api before its process integration tests');
  });

  it('keeps the product main negative when no real OCR is installed', async () => {
    expect(await run(pdf())).toEqual({
      result: incomplete,
      diagnostics: false,
      directChildStopped: true,
      transportComplete: true,
    });
  });

  it('observes real PDF parsing and rendering with a fixed quiet synthetic OCR adapter', async () => {
    expect(await run(pdf(), true)).toEqual({
      result: incomplete,
      diagnostics: false,
      directChildStopped: true,
      transportComplete: true,
    });
  });

  it('rejects the known zero-dimension image warning at the actual diagnostic boundary', async () => {
    expect(await run(pdf('Synthetic source', true), true)).toEqual({
      result: null,
      diagnostics: true,
      directChildStopped: true,
      transportComplete: false,
    });
  });

  it('preserves a real native synthetic classification rejection', async () => {
    expect(await run(pdf('Einstufung: GEHEIM'), true)).toEqual({
      result: { decision: 'rejected', reason: 'classification_marking' },
      diagnostics: false,
      directChildStopped: true,
      transportComplete: true,
    });
  });
});
