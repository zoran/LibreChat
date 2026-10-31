/** health.spec uses the real capture factory and inert SDK transport, never actual NAS or user data. */
import { Readable } from 'node:stream';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { healthBinding, healthNow } from '../../uploads/storageAvailability.helper';
import { createNasS3HealthProbe } from './health';
import { createNasS3Client } from './client';
const client = () =>
  createNasS3Client({
    backend: healthBinding.backend,
    endpoint: 'https://synthetic.invalid',
    region: 'us-east-1',
    bucket: 'cortex-files',
    credentials: {
      accessKeyId: 'SYNTHETIC_HEALTH_ACCESS',
      secretAccessKey: 'SYNTHETIC_HEALTH_SECRET',
    },
    trust: { mode: 'ca-hostname' },
    requestTimeoutMs: 1000,
  });
const context = () => ({
  signal: new AbortController().signal,
  startedAtMs: healthNow,
  deadlineAtMs: healthNow + 15000,
  maxAgeMs: 90000,
});
it('requires actual captured-client authority rather than a compatible object shape', () => {
  const foreign = new S3Client({ region: 'us-east-1' });
  expect(() => createNasS3HealthProbe(foreign, 'cpu-2')).toThrow('invalid_nas_health_client');
  foreign.destroy();
});
it('writes exactly one fixed control key and verifies all4096 fresh bytes before green', async () => {
  const c = client();
  let body: Buffer;
  const bodies: Buffer[] = [];
  const send = jest.spyOn(c, 'send').mockImplementation((async (command: unknown) => {
    if (command instanceof PutObjectCommand) {
      body = Buffer.from(command.input.Body as Buffer);
      bodies.push(body);
      expect(command.input.Key).toBe('health/v1/cpu-2');
      return { $metadata: { httpStatusCode: 200 } };
    }
    expect(command).toBeInstanceOf(GetObjectCommand);
    return { $metadata: { httpStatusCode: 200 }, ContentLength: 4096, Body: Readable.from([body]) };
  }) as never);
  try {
    const probe = createNasS3HealthProbe(c, 'cpu-2', () => healthNow);
    for (let i = 0; i < 2; i++) expect((await probe(context())).outcome).toBe('ready');
    expect(send).toHaveBeenCalledTimes(4);
    expect(bodies[0].equals(bodies[1])).toBe(false);
    expect(bodies[0]).toHaveLength(4096);
  } finally {
    c.destroy();
  }
});
it.each(['write', 'hash', 'version', 'empty-version', 'oversize'])(
  'never reports readiness from %s failure or retries an original',
  async (mode) => {
    const c = client();
    const send = jest.spyOn(c, 'send').mockImplementation((async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        if (mode === 'write') throw Error('private transport detail');
        return { $metadata: { httpStatusCode: 200 } };
      }
      let versionId: string | undefined;
      if (mode === 'version') versionId = 'unexpected';
      else if (mode === 'empty-version') versionId = '';
      return {
        $metadata: { httpStatusCode: 200 },
        VersionId: versionId,
        ContentLength: 4096,
        Body: Readable.from([Buffer.alloc(mode === 'oversize' ? 4097 : 4096)]),
      };
    }) as never);
    try {
      const result = await createNasS3HealthProbe(c, 'cpu-2', () => healthNow)(context());
      expect(result.outcome).toBe('unknown');
      expect(JSON.stringify(result)).not.toContain('private transport');
      expect(send).toHaveBeenCalledTimes(mode === 'write' ? 1 : 2);
    } finally {
      c.destroy();
    }
  },
);

it('keeps one actual SDK original until its deadline abort is joined, with no renewed clock', async () => {
  jest.useFakeTimers();
  const c = client();
  let now = healthNow;
  const send = jest.spyOn(c, 'send').mockImplementation(
    ((_command: unknown, options: { abortSignal: AbortSignal }) =>
      new Promise((_resolve, reject) =>
        options.abortSignal.addEventListener('abort', () => reject(Error('synthetic abort')), {
          once: true,
        }),
      )) as never,
  );
  try {
    const probe = createNasS3HealthProbe(c, 'cpu-2', () => now),
      original = probe(context());
    expect(probe({ ...context(), deadlineAtMs: healthNow + 19000 })).toBe(original);
    expect(send).toHaveBeenCalledTimes(1);
    now += 15000;
    await jest.advanceTimersByTimeAsync(15000);
    expect(await original).toMatchObject({ outcome: 'unknown', startedAtMs: healthNow });
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    c.destroy();
    jest.useRealTimers();
  }
});
