import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createOriginalIntegrity, verifyOriginalIntegrity } from './integrity';

const BLOCK = 262144;
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const signal = () => new AbortController().signal;
const manifest = (value: Buffer) => ({
  version: 1 as const,
  algorithm: 'sha256' as const,
  sha256: sha(value),
  chunkBytes: BLOCK as 262144,
  chunkSha256: Array.from({ length: Math.ceil(value.length / BLOCK) }, (_, index) =>
    sha(value.subarray(index * BLOCK, (index + 1) * BLOCK)),
  ),
});
async function collect(body: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = [];
  for await (const value of body) chunks.push(Buffer.from(value));
  return chunks;
}

describe('bounded original identity', () => {
  it('matches the standard SHA-256 abc vector independently of receive chunk boundaries', () => {
    const value = createOriginalIntegrity(3);
    value.update(Buffer.from('a'));
    value.update(Buffer.from('bc'));
    expect(value.finish()).toEqual({
      version: 1,
      algorithm: 'sha256',
      chunkBytes: BLOCK,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      chunkSha256: ['ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    });
  });

  it.each([1, BLOCK, BLOCK + 1, 2 * BLOCK + 17])(
    'uses fixed byte boundaries for %i bytes',
    (bytes) => {
      const input = Buffer.alloc(bytes, 37);
      input[bytes - 1] = 99;
      const value = createOriginalIntegrity(bytes);
      for (let at = 0; at < bytes; at += 7919) value.update(input.subarray(at, at + 7919));
      expect(value.finish()).toEqual(manifest(input));
    },
  );

  it('covers the 30 MiB ceiling with exactly 120 hashes without collecting a whole input', () => {
    const bytes = 30 * 1024 * 1024;
    const block = Buffer.alloc(BLOCK, 7);
    const whole = createHash('sha256');
    const value = createOriginalIntegrity(bytes);
    for (let index = 0; index < 120; index++) {
      value.update(block);
      whole.update(block);
    }
    expect(value.finish()).toEqual({
      version: 1,
      algorithm: 'sha256',
      chunkBytes: BLOCK,
      sha256: whole.digest('hex'),
      chunkSha256: Array(120).fill(sha(block)),
    });
  });

  it.each([0, -1, 0.5, 30 * 1024 * 1024 + 1, Number.NaN])(
    'refuses invalid declared size %s',
    (bytes) => {
      expect(() => createOriginalIntegrity(bytes)).toThrow();
    },
  );

  it('refuses short input, extra input and writes after finalization', () => {
    const short = createOriginalIntegrity(3);
    short.update(Buffer.from('ab'));
    expect(() => short.finish()).toThrow();
    const extra = createOriginalIntegrity(3);
    expect(() => extra.update(Buffer.from('abcd'))).toThrow();
    const complete = createOriginalIntegrity(3);
    complete.update(Buffer.from('abc'));
    complete.finish();
    expect(() => complete.update(Buffer.from('d'))).toThrow();
  });
});

describe('verified original stream', () => {
  it('produces original bounded blocks independently of source chunking', async () => {
    const input = Buffer.alloc(3 * BLOCK + 11, 19);
    input[BLOCK] = 42;
    async function* split() {
      for (let at = 0; at < input.length; at += 7919) yield input.subarray(at, at + 7919);
    }
    const chunks = await collect(
      verifyOriginalIntegrity(split(), input.length, manifest(input), signal()),
    );
    expect(chunks.map((chunk) => chunk.length)).toEqual([BLOCK, BLOCK, BLOCK, 11]);
    expect(Buffer.concat(chunks)).toEqual(input);
  });

  it('does not read ahead while a verified prefix is held by its consumer', async () => {
    const first = Buffer.alloc(BLOCK, 1),
      last = Buffer.alloc(7, 2);
    const input = Buffer.concat([first, last]);
    const next = jest
      .fn()
      .mockResolvedValueOnce({ done: false, value: first })
      .mockResolvedValueOnce({ done: false, value: last })
      .mockResolvedValueOnce({ done: true, value: undefined });
    const source = { [Symbol.asyncIterator]: () => ({ next }) };
    const reader = verifyOriginalIntegrity(source, input.length, manifest(input), signal())[
      Symbol.asyncIterator
    ]();
    expect(await reader.next()).toEqual({ done: false, value: first });
    expect(next).toHaveBeenCalledTimes(1);
    expect(await reader.next()).toEqual({ done: false, value: last });
    expect(next).toHaveBeenCalledTimes(3);
    expect((await reader.next()).done).toBe(true);
  });

  it.each([7, BLOCK])('withholds the final %i bytes until actual EOF', async (bytes) => {
    const input = Buffer.alloc(bytes, 8);
    let finish!: () => void;
    const eof = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const source = (async function* () {
      yield input;
      await eof;
    })();
    const reader = verifyOriginalIntegrity(source, bytes, manifest(input), signal())[
      Symbol.asyncIterator
    ]();
    let settled = false;
    const pending = reader.next().then((value) => {
      settled = true;
      return value;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    finish();
    expect(await pending).toEqual({ done: false, value: input });
    expect((await reader.next()).done).toBe(true);
  });

  it.each([0, 1, 2])('never yields corrupted block %i and closes the source', async (index) => {
    const blocks = [Buffer.alloc(BLOCK, 1), Buffer.alloc(BLOCK, 2), Buffer.alloc(9, 3)];
    const expected = Buffer.concat(blocks);
    const changed = blocks.map((block) => Buffer.from(block));
    changed[index][0] ^= 1;
    let closed = false;
    const source = (async function* () {
      try {
        yield* changed;
      } finally {
        closed = true;
      }
    })();
    const received: Buffer[] = [];
    await expect(
      (async () => {
        for await (const block of verifyOriginalIntegrity(
          source,
          expected.length,
          manifest(expected),
          signal(),
        )) {
          received.push(Buffer.from(block));
        }
      })(),
    ).rejects.toThrow();
    expect(received).toEqual(blocks.slice(0, index));
    expect(closed).toBe(true);
  });

  it.each(['reordered', 'duplicated', 'short', 'extra', 'wrong-full-hash'])(
    'rejects %s content without completing it',
    async (mode) => {
      const first = Buffer.alloc(BLOCK, 1),
        last = Buffer.alloc(BLOCK, 2);
      const expected = Buffer.concat([first, last]);
      const identity = manifest(expected);
      let chunks = [first, last];
      if (mode === 'reordered') chunks = [last, first];
      else if (mode === 'duplicated') chunks = [first, first];
      else if (mode === 'short') chunks = [first, last.subarray(1)];
      else if (mode === 'extra') chunks = [first, last, Buffer.from('x')];
      if (mode === 'wrong-full-hash') identity.sha256 = '0'.repeat(64);
      const received: Buffer[] = [];
      await expect(
        (async () => {
          for await (const block of verifyOriginalIntegrity(
            Readable.from(chunks),
            expected.length,
            identity,
            signal(),
          )) {
            received.push(Buffer.from(block));
          }
        })(),
      ).rejects.toThrow();
      expect(Buffer.concat(received).length).toBeLessThan(expected.length);
      expect(Buffer.concat(received)).toEqual(expected.subarray(0, Buffer.concat(received).length));
    },
  );

  it('uses an immutable manifest snapshot during a pending read', async () => {
    const expected = Buffer.from('hello');
    const identity = manifest(expected);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source = (async function* () {
      await gate;
      yield expected;
    })();
    const reading = collect(verifyOriginalIntegrity(source, expected.length, identity, signal()));
    identity.sha256 = '0'.repeat(64);
    identity.chunkSha256[0] = '0'.repeat(64);
    release();
    expect(Buffer.concat(await reading)).toEqual(expected);
  });

  it('rejects invalid identity before consuming its source', async () => {
    const source = { [Symbol.asyncIterator]: jest.fn(() => ({ next: jest.fn() })) };
    await expect(
      (async () =>
        collect(
          verifyOriginalIntegrity(
            source,
            5,
            { ...manifest(Buffer.from('hello')), chunkSha256: [] },
            signal(),
          ),
        ))(),
    ).rejects.toThrow();
    expect(source[Symbol.asyncIterator]).not.toHaveBeenCalled();
  });

  it('honors cancellation before disclosure and returns the source iterator', async () => {
    const first = Buffer.alloc(BLOCK, 1),
      last = Buffer.from('last');
    const expected = Buffer.concat([first, last]);
    const controller = new AbortController();
    let closed = false;
    const source = (async function* () {
      try {
        yield first;
        yield last;
      } finally {
        closed = true;
      }
    })();
    const reader = verifyOriginalIntegrity(
      source,
      expected.length,
      manifest(expected),
      controller.signal,
    )[Symbol.asyncIterator]();
    expect((await reader.next()).value).toEqual(first);
    controller.abort();
    await expect(reader.next()).rejects.toThrow();
    expect(closed).toBe(true);
  });

  it('joins iterator cleanup when the consumer returns early', async () => {
    const first = Buffer.alloc(BLOCK, 1),
      last = Buffer.from('last');
    let closed = false;
    const source = (async function* () {
      try {
        yield first;
        yield last;
      } finally {
        closed = true;
      }
    })();
    for await (const _ of verifyOriginalIntegrity(
      source,
      first.length + last.length,
      manifest(Buffer.concat([first, last])),
      signal(),
    ))
      break;
    expect(closed).toBe(true);
  });
});
