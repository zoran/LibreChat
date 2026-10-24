const { historyMaintenance } = require('~/server/services/HistoryMaintenance');
/** Clean up partial imports even when Multer omits the failed file from its removal list. */
const { logger } = require('@librechat/data-schemas');

function createHistoryImportStorage(storage, owner = historyMaintenance) {
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
          owner.markUncertain();
          logger.error('[importStorage] Failed to remove temporary import file', error);
        }
        callback(error, info);
      };
      void owner
        .callback(req, (complete) => storage[method](req, file, complete), done)
        .catch(done);
    };
  }
  return wrapped;
}

module.exports = { createHistoryImportStorage };
