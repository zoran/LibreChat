/** Clean up partial imports even when Multer omits the failed file from its removal list. */
const { logger } = require('@librechat/data-schemas');

function createHistoryImportStorage(storage) {
  const wrapped = {};
  for (const method of ['_handleFile', '_removeFile']) {
    wrapped[method] = (req, file, callback) => {
      let called = false;
      const done = (error, info) => {
        if (called) return;
        called = true;
        if (method === '_handleFile' && error && file.path) {
          wrapped._removeFile(req, file, () => callback(error, info));
          return;
        }
        if (error && method === '_removeFile') {
          logger.error('[importStorage] Failed to remove temporary import file', error);
        }
        callback(error, info);
      };
      try {
        storage[method](req, file, done);
      } catch (error) {
        done(error);
      }
    };
  }
  return wrapped;
}

module.exports = { createHistoryImportStorage };
