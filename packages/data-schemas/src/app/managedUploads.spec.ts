/** managedUploads.spec.ts exercises actual AppService projection; only logger output is inert. */
import { fileConfigSchema } from 'librechat-data-provider';
import { AppService } from './service';

jest.mock('~/config/winston', () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const privateInput = () => ({
  storage: {
    kind: 'nas-s3' as const,
    uid: 'synthetic-nas',
    endpoint: 'https://nas.synthetic.invalid:8010',
    bucket: 'private-files',
    credentialsFile: '/synthetic/credentials.json',
    trust: {
      mode: 'exact-certificate' as const,
      certificateFile: '/synthetic/certificate.pem',
      sha256: 'a'.repeat(64),
    },
  },
  health: { requiredHosts: ['cpu2', 'cpu3', 'cpu4', 'cpu5'] },
});
const previousCdn = process.env.CDN_PROVIDER;
afterAll(() => {
  if (previousCdn === undefined) delete process.env.CDN_PROVIDER;
  else process.env.CDN_PROVIDER = previousCdn;
});

it('keeps private deployment details on server AppConfig and out of the actual public File value', async () => {
  const fileConfig = fileConfigSchema.parse({
    fileTokenLimit: 321,
    retentionHours: 672,
    endpoints: { default: { fileLimit: 4, supportedMimeTypes: ['text/plain'] } },
    managedUploads: privateInput(),
  });
  const config = { fileConfig };
  const app = await AppService({ config });
  expect(app.managedUploads).toEqual(fileConfig.managedUploads);
  const { managedUploads: internal, ...publicFields } = fileConfig;
  if (!internal) throw new Error('Private synthetic fixture was not parsed');
  expect(app.fileConfig).toEqual(publicFields);
  expect(Object.prototype.hasOwnProperty.call(app.fileConfig, 'managedUploads')).toBe(false);
  const serialized = JSON.stringify(app.fileConfig);
  for (const privateValue of [
    internal.storage.endpoint,
    internal.storage.credentialsFile,
    internal.storage.trust.mode,
    '/synthetic/certificate.pem',
    'managedUploads',
  ])
    expect(serialized).not.toContain(privateValue);
  expect(config.fileConfig).toBe(fileConfig);
  expect(config.fileConfig.managedUploads).toBe(internal);
});
it('preserves undefined and ordinary public-config identity when no private block is configured', async () => {
  const absent = await AppService({ config: {} });
  expect(absent.fileConfig).toBeUndefined();
  expect(absent.managedUploads).toBeUndefined();
  const fileConfig = { fileTokenLimit: 321, endpoints: { default: { fileLimit: 3 } } };
  const app = await AppService({ config: { fileConfig } });
  expect(app.fileConfig).toBe(fileConfig);
  expect(app.managedUploads).toBeUndefined();
});
it('removes an explicitly undefined private field and resolves defaults only on server composition', async () => {
  const undefinedBlock = await AppService({
    config: { fileConfig: { fileTokenLimit: 9, managedUploads: undefined } },
  });
  expect(undefinedBlock.fileConfig).toEqual({ fileTokenLimit: 9 });
  expect(Object.prototype.hasOwnProperty.call(undefinedBlock.fileConfig, 'managedUploads')).toBe(
    false,
  );
  const app = await AppService({ config: { fileConfig: { managedUploads: privateInput() } } });
  expect(app.managedUploads?.storage.requestTimeoutMs).toBe(10000);
  expect(app.managedUploads?.antivirus.signatureMaxAgeMs).toBe(86400000);
  expect(app.fileConfig).toEqual({});
});
it('refuses a malformed selected private backend rather than falling back or exposing it', async () => {
  await expect(
    AppService({
      config: {
        fileConfig: {
          managedUploads: {
            ...privateInput(),
            storage: { ...privateInput().storage, endpoint: 'http://nas.synthetic.invalid' },
          },
        },
      },
    }),
  ).rejects.toThrow('Managed upload configuration unavailable');
});
