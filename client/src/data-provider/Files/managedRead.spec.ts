import { dataService } from 'librechat-data-provider';
import { createManagedFileReadAction, readManagedFile } from './managedRead';
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  dataService: { getManagedFileReadTicket: jest.fn(), inspectManagedFileRead: jest.fn() },
}));
const ticket = () => ({
  version: 1 as const,
  readId: 'A'.repeat(43),
  fileId: 'file-a',
  representation: 'original' as const,
  admittedAt: new Date(Date.now()).toISOString(),
  notAfter: new Date(Date.now() + 10000).toISOString(),
});
beforeEach(() => jest.clearAllMocks());
it('reuses one admitted identity after a lost response and settles its original completion', async () => {
  const identity = ticket();
  jest.mocked(dataService.getManagedFileReadTicket).mockResolvedValue(identity);
  jest.mocked(dataService.inspectManagedFileRead).mockResolvedValue('completed');
  const read = jest
    .fn()
    .mockRejectedValueOnce({ response: { status: 503 } })
    .mockResolvedValue('verified bytes');
  const action = createManagedFileReadAction();
  expect(
    await readManagedFile(action, {
      userId: 'user-a',
      fileId: 'file-a',
      representation: 'original',
      read,
    }),
  ).toBe('verified bytes');
  expect(dataService.getManagedFileReadTicket).toHaveBeenCalledTimes(1);
  expect(read.mock.calls.map(([value]) => value.ticket.readId)).toEqual([
    identity.readId,
    identity.readId,
  ]);
  expect(action.completed).toBe(true);
});
it('does not automatically create a fresh identity when admission or the ticket is exhausted', async () => {
  jest
    .mocked(dataService.getManagedFileReadTicket)
    .mockRejectedValue(new Error('lost admission response'));
  const action = createManagedFileReadAction();
  const input = {
    userId: 'user-a',
    fileId: 'file-a',
    representation: 'original' as const,
    read: jest.fn(),
  };
  await expect(readManagedFile(action, input)).rejects.toThrow();
  await expect(readManagedFile(action, input)).rejects.toThrow();
  expect(dataService.getManagedFileReadTicket).toHaveBeenCalledTimes(1);
  expect(input.read).not.toHaveBeenCalled();
});
it('never transfers a pending logical read to another owner or file', async () => {
  jest.mocked(dataService.getManagedFileReadTicket).mockResolvedValue(ticket());
  const action = createManagedFileReadAction();
  const read = jest.fn().mockResolvedValue('bytes');
  await readManagedFile(action, {
    userId: 'user-a',
    fileId: 'file-a',
    representation: 'original',
    read,
  });
  await expect(
    readManagedFile(action, {
      userId: 'user-b',
      fileId: 'file-a',
      representation: 'original',
      read,
    }),
  ).rejects.toThrow();
  expect(read).toHaveBeenCalledTimes(1);
});
