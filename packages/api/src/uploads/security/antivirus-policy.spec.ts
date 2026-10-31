/** The serialized shipped policy runs in a contained native child; metadata is observed by its unfiltered owner. */
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir, constants } from 'node:os';
import {
  mkdtempSync,
  writeFileSync,
  statSync,
  lstatSync,
  rmSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { createAntivirusProcessPolicy } from './antivirus-policy';

const nativeSource = String.raw`
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
struct observation { const char *name; long value; int error; };
static struct observation observations[40];
static size_t count;
#define OBSERVE(name, ...) do { errno=0; long value=syscall(__VA_ARGS__); observations[count++]=(struct observation){name,value,errno}; } while(0)
int main(int argc, char **argv) {
  if(argc!=3)return 2;
  char victim[PATH_MAX], owned[PATH_MAX], linkpath[PATH_MAX], destination[PATH_MAX];
  if(snprintf(victim,sizeof victim,"%s/victim",argv[2])>=PATH_MAX ||
     snprintf(owned,sizeof owned,"%s/owned",argv[2])>=PATH_MAX ||
     snprintf(linkpath,sizeof linkpath,"%s/link",owned)>=PATH_MAX ||
     snprintf(destination,sizeof destination,"%s/output",owned)>=PATH_MAX)return 2;
  if(mkdir(argv[2],0700)||mkdir(owned,0700))return 2;
  int target=open(victim,O_CREAT|O_EXCL|O_RDONLY,0400);
  if(target<0||symlink(victim,linkpath)||chdir(owned))return 2;
  int fd=open(argv[1],O_RDONLY);
  if(fd<0)return 2;
  off_t bytes=lseek(fd,0,SEEK_END);
  if(bytes<=0||bytes%sizeof(struct sock_filter)||bytes/sizeof(struct sock_filter)>USHRT_MAX||lseek(fd,0,SEEK_SET)<0)return 2;
  struct sock_filter *filter=malloc((size_t)bytes);
  if(!filter||read(fd,filter,(size_t)bytes)!=bytes)return 2;
  close(fd);
  struct sock_fprog program={(unsigned short)(bytes/sizeof *filter),filter};
  uid_t uid=getuid();gid_t gid=getgid();
  umask(0077);
  if(prctl(PR_SET_DUMPABLE,0)||prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)||prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&program))return 3;
  OBSERVE("chmod-zero",SYS_chmod,victim,0600);
  OBSERVE("chmod-root",SYS_chmod,"..",0600);
  OBSERVE("chmod-symlink",SYS_chmod,linkpath,0600);
  OBSERVE("chmod-mode-zero",SYS_chmod,victim,0);
  OBSERVE("chmod-mode-644",SYS_chmod,victim,0644);
  OBSERVE("chmod-mode-777",SYS_chmod,victim,0777);
  OBSERVE("chmod-high",SYS_chmod,victim,UINT64_C(0x100000180));
  OBSERVE("fchmod",SYS_fchmod,target,0600);
  OBSERVE("fchmodat",SYS_fchmodat,AT_FDCWD,victim,0600);
  OBSERVE("fchmodat2",452,AT_FDCWD,victim,0600,0);
  OBSERVE("chown",SYS_chown,victim,uid,gid);
  OBSERVE("fchown",SYS_fchown,target,uid,gid);
  OBSERVE("lchown",SYS_lchown,linkpath,uid,gid);
  OBSERVE("fchownat",SYS_fchownat,AT_FDCWD,victim,uid,gid,0);
  OBSERVE("unlink",SYS_unlink,victim);
  OBSERVE("unlinkat",SYS_unlinkat,AT_FDCWD,victim,0);
  OBSERVE("link",SYS_link,victim,destination);
  OBSERVE("linkat",SYS_linkat,AT_FDCWD,victim,AT_FDCWD,destination,0);
  OBSERVE("symlink",SYS_symlink,victim,destination);
  OBSERVE("symlinkat",SYS_symlinkat,victim,AT_FDCWD,destination);
  OBSERVE("rename",SYS_rename,victim,destination);
  OBSERVE("renameat",SYS_renameat,AT_FDCWD,victim,AT_FDCWD,destination);
  OBSERVE("renameat2",SYS_renameat2,AT_FDCWD,victim,AT_FDCWD,destination,0);
  OBSERVE("umask-first",SYS_umask,0177);
  OBSERVE("umask-second",SYS_umask,0777);
  OBSERVE("umask-third",SYS_umask,0);
  OBSERVE("umask-bad",SYS_umask,01000);
  OBSERVE("umask-high",SYS_umask,UINT64_C(0x1000001ff));
  OBSERVE("umask-final",SYS_umask,0177);
  printf("{\"results\":[");
  for(size_t i=0;i<count;i++)printf("%s{\"name\":\"%s\",\"value\":%ld,\"error\":%d}",i?",":"",observations[i].name,observations[i].value,observations[i].error);
  puts("]}");
  return 0;
}
`;

function run(command: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '',
      error: Error | undefined;
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.stdout.on('data', (bytes: Buffer) => {
      stdout += bytes.toString();
    });
    child.stderr.on('data', (bytes: Buffer) => {
      stderr += bytes.toString();
    });
    child.once('error', (cause) => {
      error = cause;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ code, stdout, stderr });
    });
  });
}

it('keeps real off-scope metadata unchanged while only chmod0600 reports no-effect success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'av-kernel-policy-'));
  const source = join(root, 'policy.c'),
    program = join(root, 'policy');
  const policy = join(root, 'policy.bpf'),
    scope = join(root, 'scope');
  const parentMask = process.umask();
  try {
    writeFileSync(source, nativeSource, { mode: 0o600 });
    writeFileSync(policy, createAntivirusProcessPolicy(), { mode: 0o400 });
    const compiled = await run('/usr/bin/cc', [
      '-std=c11',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      source,
      '-o',
      program,
    ]);
    expect(compiled).toMatchObject({ code: 0, stderr: '' });
    const result = await run(program, [policy, scope]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const observed: { results: { name: string; value: number; error: number }[] } = JSON.parse(
      result.stdout,
    );
    const success = ['chmod-zero', 'chmod-root', 'chmod-symlink'];
    const denied = [
      'chmod-mode-zero',
      'chmod-mode-644',
      'chmod-mode-777',
      'chmod-high',
      'fchmod',
      'fchmodat',
      'fchmodat2',
      'chown',
      'fchown',
      'lchown',
      'fchownat',
      'unlink',
      'unlinkat',
      'link',
      'linkat',
      'symlink',
      'symlinkat',
      'rename',
      'renameat',
      'renameat2',
      'umask-bad',
      'umask-high',
    ];
    const masks = {
      'umask-first': 0o077,
      'umask-second': 0o177,
      'umask-third': 0o777,
      'umask-final': 0,
    };
    expect(observed.results.map((value) => value.name).sort()).toEqual(
      [...success, ...denied, ...Object.keys(masks)].sort(),
    );
    for (const name of success)
      expect(observed.results.find((value) => value.name === name)).toEqual({
        name,
        value: 0,
        error: 0,
      });
    for (const name of denied)
      expect(observed.results.find((value) => value.name === name)).toEqual({
        name,
        value: -1,
        error: constants.errno.EPERM,
      });
    for (const [name, value] of Object.entries(masks))
      expect(observed.results.find((row) => row.name === name)).toEqual({ name, value, error: 0 });
    expect(statSync(scope).mode & 0o7777).toBe(0o700);
    expect(statSync(join(scope, 'victim')).mode & 0o7777).toBe(0o400);
    expect(lstatSync(join(scope, 'owned/link')).isSymbolicLink()).toBe(true);
    expect(statSync(join(scope, 'owned/link')).mode & 0o7777).toBe(0o400);
    expect(process.umask()).toBe(parentMask);
  } finally {
    if (existsSync(scope)) chmodSync(scope, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});
