/* antivirus-scope.c owns only the ClamD Landlock domain scope before the existing setpriv launcher.
 * Closed ABI: exactly /usr/bin/setpriv plus its trusted owner-constructed argv; never a request path.
 * No privileged operation, network client, daemon, user-data parser or fallback is provided. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <signal.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <unistd.h>
struct av_ruleset { uint64_t fs, net, scoped; };
static int preconditions(void) {
  FILE *f=fopen("/proc/self/status","re"); char line[512]; int caps=0, ids=0;
  if(!f || getuid()==0 || geteuid()!=getuid() || getgid()==0 || getegid()!=getgid()) return 0;
  while(fgets(line,sizeof line,f)) {
    if(!strncmp(line,"CapInh:",7)||!strncmp(line,"CapPrm:",7)||!strncmp(line,"CapEff:",7)||!strncmp(line,"CapBnd:",7)||!strncmp(line,"CapAmb:",7)) {
      unsigned long long value=1; if(sscanf(strchr(line,':')+1,"%llx",&value)!=1||value) { fclose(f);return 0; } caps++;
    }
    if(!strncmp(line,"Uid:",4)||!strncmp(line,"Gid:",4)) {
      unsigned a,b,c,d; if(sscanf(strchr(line,':')+1,"%u%u%u%u",&a,&b,&c,&d)!=4||!a||a!=b||a!=c||a!=d){fclose(f);return 0;} ids++;
    }
  }
  gid_t groups[64];int count=getgroups(64,groups);if(count<0){fclose(f);return 0;}for(int i=0;i<count;i++)if(groups[i]!=getgid()){fclose(f);return 0;}
  fclose(f);f=fopen("/proc/sys/kernel/core_pattern","re");if(!f)return 0;if(!fgets(line,sizeof line,f))line[0]=0;fclose(f);if(strcmp(line,"core\n")&&strcmp(line,"core")&&line[0])return 0;struct rlimit r;return caps==5&&ids==2&&!getrlimit(RLIMIT_CORE,&r)&&r.rlim_cur==0&&r.rlim_max==0;
}
int main(int argc,char **argv) {
  if(argc==2&&!strcmp(argv[1],"--gate")) { puts(preconditions()?"av-rootless-gate-open":"av-rootless-gate-closed");return preconditions()?0:77; }
  if(argc<4||strcmp(argv[1],"--permit-fd=3")||strcmp(argv[2],"/usr/bin/setpriv")||!preconditions())return 77;
  pid_t parent=getppid();if(parent<=1||prctl(PR_SET_PDEATHSIG,SIGKILL)||getppid()!=parent)return 77;
  char permit=0;if(read(3,&permit,1)!=1||permit!='G')return 78;close(3);
  int abi=syscall(SYS_landlock_create_ruleset,NULL,0,1);
  if(abi<6||prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0))return 77;
  struct av_ruleset rule={0,0,3}; /* ABI6: scope abstract UNIX sockets and signals. */
  int fd=syscall(SYS_landlock_create_ruleset,&rule,sizeof rule,0);
  if(fd<0)return 77;
  int ok=syscall(SYS_landlock_restrict_self,fd,0);close(fd);if(ok)return 77;
  execv("/usr/bin/setpriv",argv+2);return 78;
}
