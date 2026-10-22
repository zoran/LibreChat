import * as service from './data-service';
import request from './request';
jest.mock('./request', () => ({
  __esModule: true,
  default: { get: jest.fn(), getResponse: jest.fn() },
}));
import { createHash } from 'node:crypto';
import { buildManagedFileReadBinding } from 'librechat-data-provider';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const input = {
  owner: { tenantId: 'tenant-a', userId: 'user-a' },
  fileId: 'file-a',
  operationId: 'file-a',
  filename: 'document.txt',
  mediaType: 'text/plain',
  source: 's3',
  bytes: 5,
  storageKey: 'private/original',
  transferGeneration: 1,
  approval: null,
  original: {
    outcome: 'durable' as const,
    bytes: 5,
    source: 's3',
    filepath: '/original',
    storageKey: 'private/original',
  },
  representation: 'preview' as const,
  preview: { text: 'hello', structure: null },
};
/** A changed source/owner must not complete a previously admitted read. Retention is independent. */
it('publishes one immutable binding builder for both repository and API consumers', () => {
  expect(typeof buildManagedFileReadBinding).toBe('function');
});
it('keeps retention independent while binding the original, owner and selected preview', () => {
  const before = buildManagedFileReadBinding(input, sha256);
  expect(buildManagedFileReadBinding({ ...input, expiredAt: '2030-01-01' } as never, sha256)).toBe(
    before,
  );
  expect(
    buildManagedFileReadBinding({ ...input, preview: { text: 'other', structure: null } }, sha256),
  ).not.toBe(before);
  expect(
    buildManagedFileReadBinding({ ...input, owner: { ...input.owner, userId: 'user-b' } }, sha256),
  ).not.toBe(before);
  expect(
    buildManagedFileReadBinding(
      { ...input, original: { ...input.original, versionId: 'new-version' } },
      sha256,
    ),
  ).not.toBe(before);
  const { preview: _preview, ...original } = input;
  expect(buildManagedFileReadBinding({ ...original, representation: 'original' }, sha256)).not.toBe(
    before,
  );
});
it('refuses substituted bytes or a structure which does not match the text', () => {
  expect(() => buildManagedFileReadBinding({ ...input, bytes: 6 }, sha256)).toThrow();
  expect(() =>
    buildManagedFileReadBinding(
      { ...input, preview: { text: 'hello', structure: {} as never } },
      sha256,
    ),
  ).toThrow();
});

/** Exercise the real wire producer; only the HTTP adapter is replaced. */
it('keeps the read ID out of URLs and sends the same identity on original/inspection requests', async () => {
  const ticket = {
    version: 1 as const,
    readId: 'A'.repeat(43),
    fileId: 'file-a',
    representation: 'original' as const,
    admittedAt: '2026-10-21T00:00:00.000Z',
    notAfter: '2026-10-21T00:02:00.000Z',
  };
  jest.mocked(request.get).mockResolvedValue(ticket);
  await expect(
    service.getManagedFileReadTicket('owner', 'file-a', 'original', { timeoutMs: 1000 }),
  ).resolves.toEqual(ticket);
  const read = { ticket, timeoutMs: 1000 };
  jest.mocked(request.getResponse).mockResolvedValue({ status: 503 } as never);
  await service.getFileDownload('owner', 'file-a', read);
  await expect(service.inspectManagedFileRead('owner', read)).resolves.toBe('unknown');
  const calls = jest.mocked(request.getResponse).mock.calls;
  expect(calls).toHaveLength(2);
  for (const [url, options] of calls) {
    expect(url).not.toContain(ticket.readId);
    expect(options?.headers).toMatchObject({ 'X-Cortex-File-Read': ticket.readId });
    expect(options?.timeout).toBe(1000);
  }
  expect(request.get).toHaveBeenCalledTimes(1);
  expect(() => service.getFilePreview('file-a', read)).toThrow('Invalid managed File read request');
});
