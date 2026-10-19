import { createSecurityProcessPolicy } from './process-policy';

/** Executes the emitted Linux classic-BPF bytes, not a second policy predicate. */
function decision(nr: number, flags = BigInt(0), arch = 0xc000003e, args: bigint[] = []): number {
  const program = createSecurityProcessPolicy();
  const data = Buffer.alloc(64);
  data.writeUInt32LE(nr >>> 0, 0);
  data.writeUInt32LE(arch >>> 0, 4);
  data.writeBigUInt64LE(flags, 16);
  args.forEach((value, index) => data.writeBigUInt64LE(value, 24 + index * 8));
  let accumulator = 0;
  for (let pc = 0, steps = 0; steps < 4096; pc++, steps++) {
    const offset = pc * 8;
    if (offset >= program.length) throw new Error('Unterminated BPF');
    const code = program.readUInt16LE(offset);
    const yes = program[offset + 2];
    const no = program[offset + 3];
    const value = program.readUInt32LE(offset + 4);
    if (code === 0x20) accumulator = data.readUInt32LE(value);
    else if (code === 0x15) pc += accumulator === value ? yes : no;
    else if (code === 0x45) pc += (accumulator & value) !== 0 ? yes : no;
    else if (code === 0x54) accumulator = (accumulator & value) >>> 0;
    else if (code === 0x06) return value;
    else throw new Error('Unexpected BPF instruction');
  }
  throw new Error('Nonterminating BPF');
}

describe('fixed x86_64 security-process kernel policy', () => {
  it('rejects foreign architectures and every x32 syscall encoding', () => {
    expect(decision(0, BigInt(0), 0x40000003)).toBe(0x80000000);
    expect(decision(0x40000000)).toBe(0x80000000);
    expect(decision(0x40000200)).toBe(0x80000000);
    for (let nr = 512; nr <= 547; nr++) expect(decision(nr)).toBe(0x50001);
  });

  it('denies network, foreign descriptors, namespaces, signals and process creation', () => {
    for (const nr of [
      41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 52, 53, 54, 55, 288, 299, 307, 425, 426, 427, 101,
      310, 311, 434, 438, 321, 323, 298, 248, 249, 250, 142, 144, 203, 155, 161, 165, 166, 272, 308,
      428, 429, 430, 431, 432, 433, 442, 62, 200, 234, 129, 297, 424, 57, 58, 303, 304, 999,
    ])
      expect(decision(nr)).toBe(0x50001);
    expect(decision(435)).toBe(0x50026);
  });

  it('permits only fixed IPC-name queries and denies high-bit aliases and foreign descriptors', () => {
    for (const fd of [0, 1, 2, 3]) expect(decision(51, BigInt(fd))).toBe(0x7fff0000);
    for (const fd of [4, 5, 1024, 0xffffffff, 0x100000000, 0x100000003])
      expect(decision(51, BigInt(fd))).toBe(0x50001);
  });

  it('permits IPC socket-type introspection only, with exact level/option/descriptor arguments', () => {
    const args = [BigInt(1), BigInt(3)];
    for (const fd of [0, 1, 2, 3])
      expect(decision(55, BigInt(fd), 0xc000003e, args)).toBe(0x7fff0000);
    for (const fd of [4, 0x100000000])
      expect(decision(55, BigInt(fd), 0xc000003e, args)).toBe(0x50001);
    for (const values of [
      [0, 3],
      [1, 0],
      [1, 4],
      [0x100000001, 3],
      [1, 0x100000003],
    ])
      expect(decision(55, BigInt(0), 0xc000003e, values.map(BigInt))).toBe(0x50001);
  });

  it('denies foreign limit mutation, file leases and arbitrary device ioctls', () => {
    expect(decision(302)).toBe(0x7fff0000);
    expect(decision(302, BigInt(1))).toBe(0x50001);
    expect(decision(302, BigInt(0), 0xc000003e, [BigInt(0), BigInt(1)])).toBe(0x50001);
    expect(decision(72, BigInt(0), 0xc000003e, [BigInt(1024)])).toBe(0x50001);
    expect(decision(16, BigInt(0), 0xc000003e, [BigInt(0x40086602)])).toBe(0x50001);
  });

  it('permits only known thread flags including all three required sharing flags', () => {
    const pthreadFlags = BigInt(0x3d0f00);
    expect(decision(56, pthreadFlags)).toBe(0x7fff0000);
    expect(decision(56, BigInt(0x10900))).toBe(0x7fff0000);
    for (const required of [BigInt(0x100), BigInt(0x800), BigInt(0x10000)])
      expect(decision(56, pthreadFlags & ~required)).toBe(0x50001);
    for (const bit of [
      BigInt(1),
      BigInt(17),
      BigInt(0x1000),
      BigInt(0x2000),
      BigInt(0x4000),
      BigInt(0x8000),
      BigInt(0x20000),
      BigInt(0x400000),
      BigInt(0x800000),
      BigInt(0x2000000),
      BigInt(0x10000000),
      BigInt(0x40000000),
      BigInt(0x100000000),
    ])
      expect(decision(56, pthreadFlags | bit)).toBe(0x50001);
  });

  it('keeps ordinary bounded byte transport and independent policy buffers', () => {
    for (const nr of [0, 1, 3, 9, 11, 12, 59, 60, 143, 145, 202, 231])
      expect(decision(nr)).toBe(0x7fff0000);
    const changed = createSecurityProcessPolicy();
    changed.fill(0);
    expect(decision(41)).toBe(0x50001);
  });
});
