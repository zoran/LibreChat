import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';

/** Test-only, ephemeral CA. An externally supplied fixture is read-only and never removed. */
export function createSecurityTlsFixture(): { directory: string; close(): void } {
  const external = process.env.SCANNER_TLS_TEST_CERTS;
  if (external) return { directory: external, close() {} };
  const certificateDirectory = mkdtempSync(join(tmpdir(), 'scanner-tls-'));
  const close = () => rmSync(certificateDirectory, { recursive: true, force: true });
  try {
    const openssl = (...args: string[]) =>
      execFileSync('openssl', args, {
        cwd: certificateDirectory,
        stdio: 'ignore',
        timeout: 10_000,
      });
    openssl(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'ca.key',
      '-out',
      'ca.pem',
      '-days',
      '1',
      '-subj',
      '/CN=Ephemeral Scanner Test CA',
    );
    for (const [name, san, usage] of [
      ['server', 'DNS:localhost,IP:127.0.0.1', 'serverAuth'],
      ['client', 'DNS:test-client', 'clientAuth'],
      ['wrong', 'DNS:wrong.invalid', 'serverAuth'],
    ]) {
      openssl(
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        name + '.key',
        '-out',
        name + '.csr',
        '-subj',
        '/CN=' + name,
      );
      writeFileSync(
        join(certificateDirectory, name + '.ext'),
        `subjectAltName=${san}\nextendedKeyUsage=${usage}\n`,
        { mode: 0o600 },
      );
      openssl(
        'x509',
        '-req',
        '-in',
        name + '.csr',
        '-CA',
        'ca.pem',
        '-CAkey',
        'ca.key',
        '-CAcreateserial',
        '-out',
        name + '.pem',
        '-days',
        '1',
        '-extfile',
        name + '.ext',
      );
    }
    return { directory: certificateDirectory, close };
  } catch (error) {
    close();
    throw error;
  }
}
