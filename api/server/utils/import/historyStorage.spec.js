const history = require('../../../../packages/api/src/conversations/history');
const http = require('../../../../packages/api/src/conversations/historyHttp');
jest.mock('@librechat/api', () =>
  jest.requireActual('../../../../packages/api/src/conversations/historyHttp'),
);
const { createHistoryImportStorage } = require('./historyStorage');

function fixture() {
  const owner = history.createHistoryMutationOwner();
  const req = { app: { locals: { historyMaintenance: owner } } };
  return { owner, req };
}

describe('actual import storage callback lifetimes', () => {
  it.each([false, true])(
    'tracks real Multer abort and its discarded late-removal error=%s',
    async (fails) => {
      const { PassThrough } = require('stream');
      const multer = require('multer');
      const { owner } = fixture();
      const req = new PassThrough();
      req.app = { locals: { historyMaintenance: owner } };
      req.headers = {
        'content-type': 'multipart/form-data; boundary=history-test',
        'transfer-encoding': 'chunked',
      };
      let started;
      const accepted = new Promise((resolve) => {
        started = resolve;
      });
      let completeWrite;
      let completeRemoval;
      const storage = createHistoryImportStorage({
        _handleFile: (_req, file, cb) => {
          completeWrite = cb;
          file.stream.resume();
          started();
        },
        _removeFile: (_req, _file, cb) => {
          completeRemoval = cb;
        },
      });
      const upload = multer({ storage }).single('file');
      let uploadError;
      const handled = http.createHistoryMutationHandler('conversation-import', async () => {
        await new Promise((resolve) =>
          upload(req, {}, (error) => {
            uploadError = error;
            resolve();
          }),
        );
      })(req, {}, jest.fn());
      req.write(
        '--history-test\r\nContent-Disposition: form-data; name="file"; filename="import.json"\r\nContent-Type: application/json\r\n\r\n{}',
      );
      await accepted;
      req.destroy(new Error('client aborted'));
      await handled;
      expect(uploadError).toBeInstanceOf(Error);
      owner.pauseAdmissions('a');
      expect((await owner.getMaintenanceCensus('a')).pendingWrites).toBe(1);
      completeWrite(null, { path: '/synthetic/late-import' });
      expect(completeRemoval).toEqual(expect.any(Function));
      expect((await owner.getMaintenanceCensus('a')).pendingWrites).toBe(1);
      completeRemoval(fails ? new Error('late unlink failed') : null);
      expect(await owner.getMaintenanceCensus('a')).toMatchObject({
        pendingWrites: 0,
        complete: !fails,
      });
    },
  );

  it('retains late abort cleanup after the upload middleware has already returned', async () => {
    const { owner, req } = fixture();
    let completeWrite;
    let completeRemoval;
    const storage = createHistoryImportStorage({
      _handleFile: (_req, _file, cb) => {
        completeWrite = cb;
      },
      _removeFile: (_req, _file, cb) => {
        completeRemoval = cb;
      },
    });
    const file = {};
    await http.createHistoryMutationHandler('conversation-import', async () => {
      storage._handleFile(req, file, () => storage._removeFile(req, file, () => {}));
    })(req, {}, jest.fn());
    owner.pauseAdmissions('a');
    expect((await owner.getMaintenanceCensus('a')).pendingWrites).toBe(1);
    completeWrite(null, { path: '/synthetic/file' });
    expect((await owner.getMaintenanceCensus('a')).pendingWrites).toBe(1);
    completeRemoval(null);
    expect(await owner.getMaintenanceCensus('a')).toMatchObject({
      pendingWrites: 0,
      complete: true,
    });
  });

  it.each([false, true])(
    'awaits partial-file removal and retains failed=%s cleanup uncertainty',
    async (fails) => {
      const { owner, req } = fixture();
      let remove;
      const callback = jest.fn();
      const storage = createHistoryImportStorage({
        _handleFile: (_req, _file, cb) => cb(new Error('write aborted')),
        _removeFile: (_req, _file, cb) => {
          remove = cb;
        },
      });
      await http.createHistoryMutationHandler('conversation-import', async () => {
        storage._handleFile(req, { path: '/synthetic/partial' }, callback);
      })(req, {}, jest.fn());
      owner.pauseAdmissions('a');
      expect(callback).not.toHaveBeenCalled();
      expect((await owner.getMaintenanceCensus('a')).pendingWrites).toBe(2);
      remove(fails ? new Error('unlink failed') : null);
      expect(callback).toHaveBeenCalledWith(expect.any(Error), undefined);
      expect(await owner.getMaintenanceCensus('a')).toMatchObject({
        pendingWrites: 0,
        complete: !fails,
      });
    },
  );
});
