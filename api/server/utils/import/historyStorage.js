/** Import owns its temporary storage callbacks, including cleanup after Multer has returned. */
const { getHistoryMutationScope } = require('@librechat/api');

function createHistoryImportStorage(storage) {
  const wrapped = {};
  for (const method of ['_handleFile', '_removeFile']) {
    wrapped[method] = (req, file, callback) => {
      const scope = getHistoryMutationScope(req);
      const release = scope?.hold('write');
      let called = false;
      const done = (error, info) => {
        if (called) {
          scope?.uncertain();
          return;
        }
        called = true;
        if (error && method === '_removeFile') scope?.uncertain();
        try {
          // Multer may synchronously start late removal here. Retain it before release.
          callback(error, info);
        } finally {
          release?.();
        }
      };
      try {
        storage[method](req, file, (error, info) => {
          // A failed disk write can leave a partial file absent from Multer's removal list.
          if (method === '_handleFile' && error && file.path) {
            wrapped._removeFile(req, file, () => done(error, info));
          } else {
            done(error, info);
          }
        });
      } catch (error) {
        scope?.uncertain();
        done(error);
      }
    };
  }
  return wrapped;
}

module.exports = { createHistoryImportStorage };
