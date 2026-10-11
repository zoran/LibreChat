jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn() },
}));
const { logger } = require('@librechat/data-schemas');
const { createHistoryImportStorage } = require('./historyStorage');

beforeEach(() => jest.clearAllMocks());

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
      completeWrite(null, { path: '/synthetic/late-import' });
      expect(completeRemoval).toEqual(expect.any(Function));
      const error = fails ? new Error('late unlink failed') : null;
      completeRemoval(error);
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
