import { join } from 'node:path';
import { request } from 'node:http';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import type { UploadSecurityPort } from '../contract';
import type { IntakeChannel } from './channel';
import { UploadManagementError } from '../errors';
import { startIntakeService } from './service';

const origin = 'https://cortex.example.test';
const bodyPath = '/api/uploads/operations/11111111-1111-4111-8111-111111111111/body';
const capability = 'A'.repeat(43);
describe('isolated intake HTTP service with real router, socket lifecycle and attempt journal', () => {
  let root: string;
  let cgroupDirectory: string;
  const services: Awaited<ReturnType<typeof startIntakeService>>[] = [];
  beforeEach(async () => {
    if (!process.env.UPLOAD_TEST_TMPDIR) throw new Error('Explicit upload test directory required');
    await mkdir(process.env.UPLOAD_TEST_TMPDIR, { recursive: true });
    root = await mkdtemp(join(process.env.UPLOAD_TEST_TMPDIR, 'intake-service-'));
    cgroupDirectory = await mkdtemp(join(process.env.UPLOAD_TEST_TMPDIR, 'intake-cgroup-fixture-'));
    // Synthetic cgroup files; the service's filesystem and resource guard remain real.
    await Promise.all([
      writeFile(join(cgroupDirectory, 'memory.current'), '33554432\n'),
      writeFile(join(cgroupDirectory, 'memory.max'), '1073741824\n'),
    ]);
  });
  afterEach(async () => {
    for (const service of services.splice(0))
      if (!(await service.close()).complete) throw new Error('Incomplete scoped service cleanup');
    await rm(root, { recursive: true, force: true });
    await rm(cgroupDirectory, { recursive: true, force: true });
  });
  async function setup(channel?: IntakeChannel, stagingRoot = root) {
    const control = jest.fn(
      async (_input: Parameters<IntakeChannel['control']>[0]): Promise<unknown> => {
        throw new UploadManagementError('unauthorized');
      },
    );
    const promote = jest.fn(
      async (_input: Parameters<IntakeChannel['promote']>[0]): Promise<unknown> => {
        throw new Error('Unexpected promotion');
      },
    );
    const unreachable = async (): Promise<never> => {
      throw new Error('Unexpected scanner call');
    };
    const security: UploadSecurityPort = {
      policySha256: 'a'.repeat(64),
      prepare: unreachable,
      inspect: unreachable,
      cancel: unreachable,
    };
    const service = await startIntakeService({
      channel: channel ?? { control, promote },
      security,
      worker: { hostId: 'intake-host', instanceId: 'intake-pod' },
      stagingRoot,
      localResources: { cgroupDirectory, storage: 'disk' },
      allowedOrigins: [origin],
      host: '127.0.0.1',
      port: 0,
      deadlineMs: 3000,
    });
    services.push(service);
    return { service, control, promote };
  }
  function call(
    port: number,
    path = bodyPath,
    headers: Record<string, string> = {},
    method = 'PUT',
  ) {
    return new Promise<{ status: number; data: unknown; allowOrigin?: string }>((resolve) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            Origin: origin,
            'X-Upload-Capability': capability,
            'X-Upload-Filename': 'note.txt',
            'Content-Type': 'application/octet-stream',
            'Content-Length': 5,
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => {
            const bytes = Buffer.concat(chunks).toString();
            resolve({
              status: res.statusCode!,
              data: bytes ? JSON.parse(bytes) : null,
              allowOrigin: res.headers['access-control-allow-origin'],
            });
          });
          res.on('error', () => resolve({ status: 0, data: null }));
        },
      );
      req.on('error', () => resolve({ status: 0, data: null }));
      req.end('hello');
    });
  }
  it('retains exact public body routing and same-origin policy without opening CORS', async () => {
    const f = await setup();
    expect(
      await call(f.service.address.port, bodyPath, { Origin: 'https://foreign.example.test' }),
    ).toMatchObject({ status: 403, data: { code: 'forbidden' }, allowOrigin: undefined });
    expect(await call(f.service.address.port, `${bodyPath}?capability=secret`)).toMatchObject({
      status: 400,
      data: { code: 'invalid_request' },
    });
    expect(await call(f.service.address.port, '/api/uploads/operations')).toMatchObject({
      status: 404,
    });
    expect(await call(f.service.address.port, bodyPath, {}, 'POST')).toMatchObject({ status: 404 });
    expect(f.control).not.toHaveBeenCalled();
    expect(await call(f.service.address.port)).toMatchObject({
      status: 401,
      data: { code: 'unauthorized' },
    });
    expect(f.control).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: '11111111-1111-4111-8111-111111111111',
        capability,
        command: { action: 'authorize', dispatch: null },
      }),
    );
  });
  it.each(['Cookie', 'Authorization'])(
    'rejects application credentials before entering the source adapters: %s',
    async (name) => {
      const f = await setup();
      expect(
        await call(f.service.address.port, bodyPath, { [name]: 'private-credential' }),
      ).toMatchObject({
        status: 400,
        data: { code: 'invalid_request' },
      });
      expect(f.control).not.toHaveBeenCalled();
      expect(f.promote).not.toHaveBeenCalled();
    },
  );
  it('reports incomplete close while a deliberately uncooperative authorization call remains live', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const f = await setup({
      control: async () => {
        entered();
        await blocked;
        throw new UploadManagementError('unauthorized');
      },
      promote: async () => {
        throw new Error('Unexpected promotion');
      },
    });
    const pending = call(f.service.address.port);
    await started;
    expect(f.service.maintenance.pauseAdmissions('maintenance-test')).toBe(true);
    expect(await f.service.maintenance.getMaintenanceCensus('maintenance-test')).toMatchObject({
      admissionClosed: true,
      complete: false,
    });
    expect(f.service.maintenance.resumeAdmissions('maintenance-test')).toBe(false);
    expect(await call(f.service.address.port)).toMatchObject({ status: 503 });
    expect(await f.service.close(AbortSignal.timeout(20))).toEqual({ complete: false });
    release();
    await pending;
    expect(await f.service.close()).toEqual({ complete: true });
  });
  it('pauses admission before native authorization and resumes only the matching maintenance scope', async () => {
    const f = await setup();
    expect(f.service.maintenance.pauseAdmissions('maintenance-a')).toBe(true);
    expect(await call(f.service.address.port)).toMatchObject({ status: 503 });
    expect(f.control).not.toHaveBeenCalled();
    expect(await f.service.maintenance.getMaintenanceCensus('maintenance-a')).toEqual({
      admissionClosed: true,
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
    expect(f.service.maintenance.resumeAdmissions('maintenance-b')).toBe(false);
    expect(f.service.maintenance.resumeAdmissions('maintenance-a')).toBe(true);
    expect(await call(f.service.address.port)).toMatchObject({ status: 401 });
    expect(f.control).toHaveBeenCalledTimes(1);
  });
  it('preserves unknown staging data and refuses to attest complete cleanup', async () => {
    const f = await setup();
    const unknown = join(root, 'unknown-original');
    await writeFile(unknown, 'synthetic', { mode: 0o600 });
    expect(await f.service.close()).toEqual({ complete: false });
    await rm(unknown);
    expect(await f.service.close()).toEqual({ complete: true });
  });
  it('rejects a permissive or symlinked staging root before listening', async () => {
    await chmod(root, 0o755);
    await expect(setup()).rejects.toThrow('Invalid intake staging root');
    await chmod(root, 0o700);
    const link = join(root, 'alias');
    await symlink(root, link);
    await expect(setup(undefined, link)).rejects.toThrow('Invalid intake staging root');
    await rm(link);
  });
  it('refuses startup on unknown local memory rather than listening with an unchecked intake pool', async () => {
    await rm(join(cgroupDirectory, 'memory.max'));
    await expect(setup()).rejects.toMatchObject({ code: 'unavailable' });
    expect(services).toHaveLength(0);
  });
});
