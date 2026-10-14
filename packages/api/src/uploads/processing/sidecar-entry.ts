import path from 'node:path';
import { startDocumentSidecar } from './sidecar';

async function main() {
  const sidecar = await startDocumentSidecar({
    socketPath: process.env.UPLOAD_PARSER_SOCKET ?? '/var/run/cortex-upload-parser/parser.sock',
    stagingRoot: process.env.UPLOAD_STAGING_ROOT ?? '/var/lib/cortex/uploads/staging',
    scratchRoot: process.env.UPLOAD_PARSER_SCRATCH ?? '/var/lib/cortex/parser',
    cgroupDirectory: '/sys/fs/cgroup',
    childEntry: path.join(__dirname, 'parser-child.cjs'),
  });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void sidecar.close().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}

void main().catch(() => {
  console.error('upload_parser_start_failed');
  process.exitCode = 1;
});
