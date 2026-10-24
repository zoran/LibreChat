jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn() },
}));
const { logger } = require('@librechat/data-schemas');
const { createHistoryImportStorage: wrapStorage } = require('./historyStorage');
const { createHistoryMaintenance } = require('~/server/services/HistoryMaintenance');
let owner;
const createHistoryImportStorage = (storage) => wrapStorage(storage, owner);
const tick = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  owner = createHistoryMaintenance();
});

describe('import storage cleanup', () => {
  it.each([false, true])(
    'cleans up after a real Multer abort and logs removal failure=%s',
    async (fails) => {
      const { PassThrough } = require('stream');
      const multer = require('multer');
      const req = new PassThrough();
      req.headers = {
        'content-type': 'multipart/form-data; boundary=import-test',
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
      const handled = new Promise((resolve) => upload(req, {}, resolve));
      req.write(
        '--import-test\r\nContent-Disposition: form-data; name="file"; filename="import.json"\r\nContent-Type: application/json\r\n\r\n{}',
      );
      await accepted;
      req.destroy(new Error('client aborted'));
      expect(await handled).toBeInstanceOf(Error);
      expect(owner.pauseAdmissions('import-abort')).toBe(true);
      expect((await owner.getMaintenanceCensus('import-abort')).pendingWrites).toBe(1);
      completeWrite(null, { path: '/synthetic/late-import' });
      expect(completeRemoval).toEqual(expect.any(Function));
      await tick();
      expect((await owner.getMaintenanceCensus('import-abort')).pendingWrites).toBe(1);
      let drained = false;
      const drain = owner.drain().then(
        () => {
          drained = true;
        },
        (error) => error,
      );
      await tick();
      expect(drained).toBe(false);
      const error = fails ? new Error('late unlink failed') : null;
      completeRemoval(error);
      await tick();
      expect(await owner.getMaintenanceCensus('import-abort')).toMatchObject({
        pendingWrites: 0,
        complete: !fails,
      });
      const result = await drain;
      if (fails) expect(result.message).toBe('HISTORY_SETTLEMENT_UNCONFIRMED');
      else expect(drained).toBe(true);
      if (fails) {
        expect(logger.error).toHaveBeenCalledWith(
          '[importStorage] Failed to remove temporary import file',
          error,
        );
      } else {
        expect(logger.error).not.toHaveBeenCalled();
      }
    },
  );

  it.each([false, true])(
    'waits for partial-file removal and logs cleanup failure=%s',
    async (fails) => {
      let remove;
      const callback = jest.fn();
      const writeError = new Error('write aborted');
      const removal = jest.fn((_req, _file, cb) => {
        remove = cb;
      });
      const storage = createHistoryImportStorage({
        _handleFile: (_req, _file, cb) => cb(writeError),
        _removeFile: removal,
      });
      const req = {};
      const file = { path: '/synthetic/partial' };
      storage._handleFile(req, file, callback);
      expect(removal).toHaveBeenCalledWith(req, file, expect.any(Function));
      expect(callback).not.toHaveBeenCalled();
      const cleanupError = fails ? new Error('unlink failed') : null;
      remove(cleanupError);
      expect(callback).toHaveBeenCalledWith(writeError, undefined);
      expect(callback).toHaveBeenCalledTimes(1);
      if (fails) {
        expect(logger.error).toHaveBeenCalledWith(
          '[importStorage] Failed to remove temporary import file',
          cleanupError,
        );
      } else {
        expect(logger.error).not.toHaveBeenCalled();
      }
    },
  );

  it('cleans up a synchronous storage failure without reporting it twice', () => {
    const error = new Error('disk write failed');
    const callback = jest.fn();
    const removal = jest.fn((_req, _file, cb) => {
      cb(null);
      cb(null);
    });
    const storage = createHistoryImportStorage({
      _handleFile: () => {
        throw error;
      },
      _removeFile: removal,
    });
    storage._handleFile({}, { path: '/synthetic/partial' }, callback);
    expect(removal).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(error, undefined);
  });
});
