/** Isolated raw ingress. No App bootstrap, database credentials or ordinary object-store client. */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHttpUploadSecurityPort } from '../security/transport';
import { createMaintenanceIdentity } from '../../app/identity';
import { createIntakeChannel } from './channel';
import { startIntakeService } from './service';

async function main(): Promise<void> {
  const identity = createMaintenanceIdentity(process.env, true);
  if (
    Object.keys(process.env).some((name) =>
      /^(?:JWT_SECRET|JWT_REFRESH_SECRET|MONGO_URI|DATABASE_URL|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|OPENAI_API_KEY)$/.test(
        name,
      ),
    )
  )
    throw new Error('Intake credential boundary unavailable');
  const material = async (name: string): Promise<Buffer> => {
    const file = process.env[name];
    if (!file || !path.isAbsolute(file)) throw new Error('Intake configuration unavailable');
    const bytes = await readFile(file);
    if (!bytes.length || bytes.length > 65536) throw new Error('Intake configuration unavailable');
    return bytes;
  };
  const tls = async (prefix: string): Promise<{ ca: Buffer; cert: Buffer; key: Buffer }> => {
    const [ca, cert, key] = await Promise.all(
      ['CA', 'CERT', 'KEY'].map((key) => material(`${prefix}_${key}_FILE`)),
    );
    return { ca, cert, key };
  };
  const [appTls, securityTls] = await Promise.all([
    tls('UPLOAD_INTAKE_CLIENT'),
    tls('UPLOAD_SECURITY_TLS'),
  ]);
  const channel = createIntakeChannel({
    endpoint: process.env.UPLOAD_INTAKE_APP_ENDPOINT ?? '',
    allowedHosts: (process.env.UPLOAD_INTAKE_APP_ALLOWED_HOSTS ?? '').split(',').filter(Boolean),
    tls: appTls,
  });
  const security = createHttpUploadSecurityPort({
    endpoint: process.env.UPLOAD_SECURITY_ENDPOINT ?? '',
    allowedHosts: (process.env.UPLOAD_SECURITY_ALLOWED_HOSTS ?? '').split(',').filter(Boolean),
    policySha256: process.env.UPLOAD_SECURITY_POLICY_SHA256 ?? '',
    tls: securityTls,
  });
  const service = await startIntakeService({
    channel,
    security,
    worker: { hostId: process.env.POD_NODE_NAME ?? '', instanceId: identity.incarnation },
    stagingRoot: process.env.UPLOAD_INTAKE_ROOT ?? '/var/run/cortex-intake',
    allowedOrigins: (process.env.UPLOAD_INTAKE_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
  });
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void service.close(AbortSignal.timeout(30_000)).then(
      (result) => {
        process.exitCode = result.complete ? 0 : 1;
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
  console.error('upload_intake_start_failed');
  process.exitCode = 1;
});
