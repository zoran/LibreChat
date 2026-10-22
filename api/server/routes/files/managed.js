/** Express composition only; managed File HTTP behavior belongs to @librechat/api. */
const { createManagedFileHandlers: createHandlers } = require('@librechat/api');
const { runAsSystem } = require('@librechat/data-schemas');
const { getContentDisposition } = require('~/server/utils/files');
const {
  isCortexFileMode,
  rejectUnmanagedFileWrites,
} = require('~/server/middleware/requireManagedIntake');

const createManagedFileHandlers = (options) =>
  createHandlers(
    {
      getRuntime: () => require('~/server/services/Uploads').getUploadRuntime(),
      getFiles: (...args) => require('~/models').getFiles(...args),
      runAsSystem,
      getContentDisposition,
    },
    options,
  );

module.exports = { isCortexFileMode, rejectUnmanagedFileWrites, createManagedFileHandlers };
