/** antivirus-policy.ts owns only the ClamD x86_64 syscall policy; filesystem and original-process custody remain separate. */
export const ANTIVIRUS_PROCESS_POLICY_VERSION = 'linux-x86_64-clamd-unix-v1';

// Linux x86_64 ABI numbers, deliberately not host-dependent discovery. Everything else is EPERM.
// File opens remain subject to Landlock; no device or directory is granted by the launcher.
const ALLOWED = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 19, 20, 21, 22, 23, 24, 25, 28, 32, 33,
  35, 39, 59, 60, 63, 79, 89, 96, 97, 98, 99, 102, 104, 107, 108, 110, 125, 126, 131, 137, 138, 143,
  145, 157, 158, 186, 202, 204, 217, 218, 219, 228, 229, 230, 231, 232, 233, 257, 262, 267, 269,
  270, 271, 273, 281, 283, 286, 287, 290, 291, 292, 293, 295, 309, 318, 324, 332, 334, 436, 437,
  439, 441, 444, 445, 446, 449,
] as const;

/** Fresh deterministic sock_filter bytes for setpriv --seccomp-filter, little-endian x86_64. */
export function createAntivirusProcessPolicy(): Buffer {
  const instructions: number[][] = [];
  const add = (code: number, k: number, yes = 0, no = 0) =>
    instructions.push([code, yes, no, k >>> 0]);
  const deny = 0x00050001;
  const allow = 0x7fff0000;
  add(0x20, 4); // seccomp_data.arch
  add(0x15, 0xc000003e, 1);
  add(0x06, 0x80000000);
  add(0x20, 0); // seccomp_data.nr
  add(0x45, 0x40000000, 0, 1); // x32 shares AUDIT_ARCH_X86_64
  add(0x06, 0x80000000);
  add(0x15, 435, 0, 1); // clone3 has pointer arguments: never inspect mutable user memory
  add(0x06, 0x00050026); // ENOSYS permits libc's inspectable clone fallback
  add(0x15, 56, 0, 10);
  add(0x20, 20); // high half of clone flags must be zero
  add(0x15, 0, 1);
  add(0x06, deny);
  add(0x20, 16);
  // VM, FS, FILES, SIGHAND, THREAD, SYSVSEM, SETTLS, PARENT_SETTID, CHILD_CLEARTID/SETTID.
  add(0x45, ~0x013d0f00, 0, 1);
  add(0x06, deny);
  add(0x54, 0x00010900); // VM + SIGHAND + THREAD are all mandatory
  add(0x15, 0x00010900, 1);
  add(0x06, deny);
  add(0x06, allow);
  const restrictedArgument = (
    syscall: number,
    argument: number,
    values: number[],
    result = allow,
  ) => {
    add(0x15, syscall, 0, 5 + values.length * 2);
    add(0x20, 20 + argument * 8);
    add(0x15, 0, 1);
    add(0x06, deny);
    add(0x20, 16 + argument * 8);
    for (const value of values) {
      add(0x15, value, 0, 1);
      add(0x06, result);
    }
    add(0x06, deny);
  };
  // ClamD requests mode 0600; the trusted parent alone commits and observes that mode.
  restrictedArgument(90, 1, [0o600], 0x00050000); // Return zero without executing chmod.
  add(0x15, 95, 0, 7); // umask changes only this original's process-local creation mask.
  add(0x20, 20);
  add(0x15, 0, 1);
  add(0x06, deny);
  add(0x20, 16);
  add(0x45, ~0o777 >>> 0, 1);
  add(0x06, allow);
  add(0x06, deny);
  // Only AF_UNIX SOCK_STREAM creation; no INET/INET6 and no connect syscall.
  for (const syscall of [41, 53]) {
    const block: number[][] = [];
    const emit = (code: number, k: number, yes = 0, no = 0) => block.push([code, yes, no, k]);
    for (const offset of [20, 28]) {
      emit(0x20, offset);
      emit(0x15, 0, 1);
      emit(0x06, deny);
    }
    emit(0x20, 16);
    emit(0x15, 1, 1);
    emit(0x06, deny);
    emit(0x20, 24);
    emit(0x54, ~(0x80000 | 0x800) >>> 0);
    emit(0x15, 1, 0, 1);
    emit(0x06, allow);
    emit(0x06, deny);
    add(0x15, syscall, 0, block.length);
    instructions.push(...block);
  }
  // The separately pinned scope helper requires Landlock ABI6 abstract-UNIX/signal isolation.
  for (const syscall of [43, 49, 50, 51, 52, 55, 288]) {
    add(0x15, syscall, 0, 1);
    add(0x06, allow);
  }
  // Only ordinary descriptor flags and pipe/terminal introspection, never leases/device control.
  restrictedArgument(72, 1, [0, 1, 2, 3, 4, 1030]);
  restrictedArgument(16, 1, [0x5401, 0x5413, 0x541b, 0x5421]);
  // Node may query its own limits, not lower another process's limits or change its hard bounds.
  add(0x15, 302, 0, 13);
  for (const offset of [16, 20, 32, 36]) {
    add(0x20, offset);
    add(0x15, 0, 1);
    add(0x06, deny);
  }
  add(0x06, allow);
  for (const syscall of ALLOWED) {
    add(0x15, syscall, 0, 1);
    add(0x06, allow);
  }
  add(0x06, deny);
  const program = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, yes, no, k], index) => {
    const offset = index * 8;
    program.writeUInt16LE(code, offset);
    program[offset + 2] = yes;
    program[offset + 3] = no;
    program.writeUInt32LE(k, offset + 4);
  });
  return program;
}
