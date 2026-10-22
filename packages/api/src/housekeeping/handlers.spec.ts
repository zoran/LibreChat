import type {
  JobClaim,
  PreparedNotice,
  StepOutcome,
  FileNoticePort,
} from '@librechat/data-schemas';
import type { RetentionMailInput, RetentionMailOutcome } from '../files/retentionMailSender';
import { createHousekeepingHandlers } from './handlers';
const claim = {
  jobId: 'job',
  claimId: 'claim',
  fence: 3,
  executionId: 'execution',
  progressRevision: 2,
  work: { handler: 'file.warning' },
} as JobClaim;
const prepared: PreparedNotice = {
  state: 'prepared',
  submissionId: 'same-execution',
  snapshotToken: 'opaque',
  recipient: 'user@example.test',
  offsetDays: 1,
  late: true,
  timezone: 'UTC',
  snapshot: {
    asOf: '2026-10-21T00:00:00Z',
    files: [
      {
        subject: { fileId: 'file', tenantId: null, ownerUserId: 'owner' },
        filename: 'Document',
        acceptedAt: null,
        deadlineAt: '2026-10-22T00:00:00Z',
        deadlineGeneration: 2,
        lastSuccessfulReadAt: null,
        lastReadKnown: false,
        lastSuccessfulProcessingAt: null,
        readCount: { known: false },
        processingCount: {
          known: true,
          value: 3,
          coverage: 'since',
          since: '2026-10-20T00:00:00Z',
        },
        inactivity: { known: false },
      },
    ],
  },
};
function fixture() {
  const fileNotice: jest.Mocked<FileNoticePort<RetentionMailOutcome>> = {
    prepare: jest.fn().mockResolvedValue(prepared),
    authorizeHandoff: jest.fn().mockResolvedValue(true),
    recordOutcome: jest.fn().mockResolvedValue({ state: 'settled', receiptRef: 'owner-receipt' }),
  };
  const sendReminder = jest
    .fn<Promise<RetentionMailOutcome>, [RetentionMailInput]>()
    .mockResolvedValue({ state: 'accepted', relayIndex: 0 });
  const fileCleanup = {
    step: jest.fn().mockResolvedValue({ state: 'pending', code: 'external_pending' }),
  };
  const uploadCleanup = {
    step: jest.fn().mockResolvedValue({ state: 'settled', receiptRef: 'upload-owner' }),
  };
  const deps = { fileNotice, fileCleanup, uploadCleanup, mailSender: { sendReminder } };
  return {
    deps,
    fileNotice,
    sendReminder,
    fileCleanup,
    uploadCleanup,
    handlers: createHousekeepingHandlers(deps),
    abort: new AbortController(),
  };
}
test.each<RetentionMailOutcome>([
  { state: 'accepted', relayIndex: 1 },
  { state: 'notAccepted', reason: 'unavailable' },
  { state: 'unknown', reason: 'acknowledgementUnknown' },
])('records the exact %s sender outcome once with no runtime SMTP retry', async (outcome) => {
  const f = fixture();
  f.sendReminder.mockResolvedValue(outcome);
  await f.handlers['file.warning'](claim, f.abort.signal);
  expect(f.sendReminder).toHaveBeenCalledTimes(1);
  expect(f.fileNotice.recordOutcome).toHaveBeenCalledWith(claim, 'opaque', outcome);
});
test('projects only owner snapshot presentation and reuses exact claim on repeated handoff checks', async () => {
  const f = fixture();
  await f.handlers['file.warning'](claim, f.abort.signal);
  const input = f.sendReminder.mock.calls[0][0];
  expect(input.submissionId).toBe('same-execution');
  expect(input.notice.asOf).toBe(prepared.snapshot.asOf);
  expect(input.notice.files[0]).not.toHaveProperty('subject');
  expect(input.notice.files[0]).not.toHaveProperty('deadlineGeneration');
  expect(input.notice.files[0].processingCount).toEqual(prepared.snapshot.files[0].processingCount);
  await input.authorizeHandoff(f.abort.signal);
  await input.authorizeHandoff(f.abort.signal);
  expect(f.fileNotice.authorizeHandoff.mock.calls).toEqual([
    [claim, 'opaque', f.abort.signal],
    [claim, 'opaque', f.abort.signal],
  ]);
  f.abort.abort();
  expect(await input.authorizeHandoff(f.abort.signal)).toBe(false);
  expect(f.fileNotice.authorizeHandoff).toHaveBeenCalledTimes(2);
});
test('unknown submission preparation never sends or rewrites its execution', async () => {
  const f = fixture();
  f.fileNotice.prepare.mockResolvedValue({ state: 'no_send', reason: 'submission_unknown' });
  expect(await f.handlers['file.warning'](claim, f.abort.signal)).toEqual({
    state: 'pending',
    code: 'external_pending',
  });
  expect(f.sendReminder).not.toHaveBeenCalled();
  expect(f.fileNotice.recordOutcome).not.toHaveBeenCalled();
});
test('rejected sender remains unknown; cancellation still awaits the original outcome persistence', async () => {
  const f = fixture();
  let persist!: (v: StepOutcome) => void;
  f.sendReminder.mockRejectedValue(new Error('unknown handoff'));
  f.fileNotice.recordOutcome.mockImplementation(
    () =>
      new Promise((resolve) => {
        persist = resolve;
      }),
  );
  let finished = false;
  const run = f.handlers['file.warning'](claim, f.abort.signal).then(() => {
    finished = true;
  });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  f.abort.abort();
  expect(f.fileNotice.recordOutcome).toHaveBeenCalledWith(claim, 'opaque', {
    state: 'unknown',
    reason: 'acknowledgementUnknown',
  });
  expect(finished).toBe(false);
  persist({ state: 'unknown' });
  await run;
});
test('disabled mail leaves the obligation pending without preparing or borrowing another sender', async () => {
  const f = fixture();
  const handlers = createHousekeepingHandlers({ ...f.deps, mailSender: undefined });
  expect(await handlers['file.warning'](claim, f.abort.signal)).toEqual({
    state: 'retry',
    code: 'source_unavailable',
  });
  expect(f.fileNotice.prepare).not.toHaveBeenCalled();
  expect(f.sendReminder).not.toHaveBeenCalled();
});
test('File and Upload dispatch exactly one owner step, reject wrong-handler claims, and honor cancellation', async () => {
  const f = fixture();
  const file = { ...claim, work: { handler: 'file.cleanup' } } as JobClaim;
  const upload = { ...claim, work: { handler: 'upload.cleanup' } } as JobClaim;
  await f.handlers['file.cleanup'](file, f.abort.signal);
  await f.handlers['upload.cleanup'](upload, f.abort.signal);
  expect(f.fileCleanup.step).toHaveBeenCalledWith(file, f.abort.signal);
  expect(f.uploadCleanup.step).toHaveBeenCalledWith(upload, f.abort.signal);
  await expect(f.handlers['file.cleanup'](upload, f.abort.signal)).rejects.toThrow(
    'handler mismatch',
  );
  f.abort.abort();
  await f.handlers['file.cleanup'](file, f.abort.signal);
  expect(f.fileCleanup.step).toHaveBeenCalledTimes(1);
});

test('late owner authorization cannot reopen a cancelled sender admission', async () => {
  const f = fixture();
  let permit!: (v: boolean) => void;
  f.fileNotice.authorizeHandoff.mockImplementation(
    () =>
      new Promise((resolve) => {
        permit = resolve;
      }),
  );
  await f.handlers['file.warning'](claim, f.abort.signal);
  const authorization = f.sendReminder.mock.calls[0][0].authorizeHandoff(f.abort.signal);
  f.abort.abort();
  permit(true);
  expect(await authorization).toBe(false);
});
