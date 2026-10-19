/** Real built child/PDF.js/Canvas; only the fixed test fixture supplies synthetic OCR. */
import { once } from 'node:events';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import {
  encodeSecurityProcessRequest,
  readSecurityProcessResult,
  SECURITY_PROCESS_LIMITS,
  SecurityProcessFrameReader,
} from './process-wire';

const entry = resolve(__dirname, '../../../dist/uploads/security/pdf-child.cjs');
const maximum = 4 + SECURITY_PROCESS_LIMITS.headerBytes + SECURITY_PROCESS_LIMITS.documentBytes;
const policy = { version: 1 as const, markings: ['VS-NfD', 'GEHEIM'], labels: ['Einstufung'] };

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
const request = (bytes = pdf()) =>
  Buffer.from(encodeSecurityProcessRequest({ mediaType: 'application/pdf', policy, bytes }));

// Fixed test-only composition. No script, path or OCR choice is accepted from the wire.
const fakeOcrFixture = `
const entry = process.argv[1];
const expectedPages = Number(process.argv[2]);
if (expectedPages !== 0 && expectedPages !== 1) throw new Error('Invalid fixture page count');
const maximum = 4 + 32768 + 4194304;
const frames = [], chunks = [], pixels = [];
let sawInput = false;
const allocate = Buffer.alloc;
const copy = Buffer.prototype.copy;
Buffer.alloc = function(...args) {
  const value = Reflect.apply(allocate, this, args);
  if (args[0] === maximum) frames.push(value);
  return value;
};
Buffer.prototype.copy = function(target, ...args) {
  if (frames.includes(target)) {
    chunks.push(this);
    sawInput ||= this.some(byte => byte !== 0);
  }
  return Reflect.apply(copy, this, [target, ...args]);
};
const { runPdfSecurityChild } = require(entry);
runPdfSecurityChild({ readPage: async ({ rgba }) => {
  pixels.push(rgba);
  return { complete: true, readable: true, text: '' };
}}).then(() => {
  Buffer.alloc = allocate;
  Buffer.prototype.copy = copy;
  const erased = [...frames, ...chunks, ...pixels].every(value => value.every(byte => byte === 0));
  if (!sawInput || frames.length !== 1 || !chunks.length || pixels.length !== expectedPages || !erased) {
    process.exitCode = 91;
  } else process.stdout.write('SYNTHETIC_FIXTURE_CLEANUP_OK\\n');
}, () => { process.exitCode = 92; });
`;

async function run(input: Buffer, fakeOcr = false, missingResultFd = false, expectedPages = 1) {
  const args = fakeOcr ? ['-e', fakeOcrFixture, entry, String(expectedPages)] : [entry];
  const child = spawn(process.execPath, args, {
    stdio: missingResultFd ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', 'pipe'],
    env: { NODE_ENV: 'test', LANG: 'C.UTF-8' },
  });
  const completion = once(child, 'close');
  let timedOut = false;
  let excessiveOutput = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 8000);
  const outputs: Buffer[][] = [[], [], []];
  const sizes = [0, 0, 0];
  const streams = [child.stdout, child.stderr, child.stdio[3]] as (Readable | null | undefined)[];
  for (const [index, stream] of streams.entries()) {
    stream?.on('data', (chunk: Buffer) => {
      sizes[index] += chunk.length;
      if (sizes[index] > (index === 2 ? 1600 : 65_536)) {
        excessiveOutput = true;
        child.kill('SIGKILL');
      } else outputs[index].push(chunk);
    });
  }
  // An oversized input can be rejected while the pipe still has pending bytes.
  child.stdin?.on('error', () => undefined);
  try {
    child.stdin?.end(input);
    const [code, signal] = await completion;
    if (timedOut || excessiveOutput || signal) throw new Error('Synthetic child exceeded bounds');
    const reader = new SecurityProcessFrameReader();
    let result: ReturnType<typeof readSecurityProcessResult> = null;
    reader.push(Buffer.concat(outputs[2]), (frame) => {
      if (frame.header.kind === 'result') result = readSecurityProcessResult(frame.bytes);
      frame.bytes.fill(0);
    });
    if (!reader.complete) result = null;
    reader.clear();
    return {
      code,
      stdout: Buffer.concat(outputs[0]).toString('utf8'),
      stderr: Buffer.concat(outputs[1]).toString('utf8'),
      result,
    };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await completion.catch(() => undefined);
    }
    for (const chunks of outputs) for (const chunk of chunks) chunk.fill(0);
    input.fill(0);
  }
}

describe('actual built private PDF child', () => {
  beforeAll(() => {
    if (!existsSync(entry))
      throw new Error('Build @librechat/api before its child integration tests');
  });

  it.each(['empty', 'malformed', 'truncated', 'duplicate'] as const)(
    'rejects %s input after EOF without disclosing the input',
    async (kind) => {
      const valid = request();
      let input: Buffer;
      switch (kind) {
        case 'empty':
          input = Buffer.alloc(0);
          break;
        case 'malformed':
          input = Buffer.from('Synthetic private malformed input');
          break;
        case 'truncated':
          input = valid.subarray(0, valid.length - 1);
          break;
        default:
          input = Buffer.concat([valid, valid]);
      }
      try {
        expect(await run(input)).toEqual({
          code: 1,
          stdout: '',
          stderr: '',
          result: { decision: 'uninspectable', reason: 'invalid_content' },
        });
      } finally {
        valid.fill(0);
      }
    },
  );

  it('stops oversized stdin before parsing or accumulating further input', async () => {
    expect(await run(Buffer.alloc(maximum + 1, 0x61))).toEqual({
      code: 1,
      stdout: '',
      stderr: '',
      result: { decision: 'uninspectable', reason: 'resource_limit' },
    });
  });

  it('reports a missing private result descriptor through a neutral exit code', async () => {
    expect(await run(request(), false, true)).toEqual({
      code: 2,
      stdout: '',
      stderr: '',
      result: null,
    });
  });

  it('emits parser evidence and erases owned frames, chunks and pixel buffers', async () => {
    const result = await run(request(), true);
    expect(result).toEqual({
      code: 0,
      stdout: 'SYNTHETIC_FIXTURE_CLEANUP_OK\n',
      stderr: '',
      result: { decision: 'clear', coverage: { complete: true, pages: 1, parts: 1 } },
    });
  });

  it('returns a quiet strict-image rejection before OCR and erases frames and chunks', async () => {
    const result = await run(request(pdf('Synthetic source', true)), true, false, 0);
    expect(result).toEqual({
      code: 0,
      stdout: 'SYNTHETIC_FIXTURE_CLEANUP_OK\n',
      stderr: '',
      result: { decision: 'uninspectable', reason: 'invalid_content' },
    });
  });

  it('returns a real native classification rejection with explicit fake OCR', async () => {
    const result = await run(request(pdf('Einstufung: GEHEIM')), true);
    expect(result).toEqual({
      code: 0,
      stdout: 'SYNTHETIC_FIXTURE_CLEANUP_OK\n',
      stderr: '',
      result: { decision: 'rejected', reason: 'classification_marking' },
    });
  });
});
