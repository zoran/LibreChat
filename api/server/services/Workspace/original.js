/** App dependency wiring; Workspace original streaming belongs to the typed File API owner. */
const { createWorkspaceOriginalReader: createReader } = require('@librechat/api');
const { runAsSystem } = require('@librechat/data-schemas');
const { createManagedFileHandlers } = require('~/server/routes/files/managed');

function createWorkspaceOriginalReader(options = {}) {
  const getRuntime =
    options.getRuntime ?? (() => require('~/server/services/Uploads').getUploadRuntime());
  return createReader(
    {
      getRuntime,
      authorize: options.authorize ?? createManagedFileHandlers({ getRuntime }).authorize,
      getDocumentWorkspaceVersionFile:
        options.getDocumentWorkspaceVersionFile ??
        ((...args) => require('~/models').getDocumentWorkspaceVersionFile(...args)),
      runAsSystem: options.runAsSystem ?? runAsSystem,
      policySha256: () => options.securityPolicySha256 ?? process.env.UPLOAD_SECURITY_POLICY_SHA256,
    },
    { now: options.now, monotonic: options.monotonic, deadlineMs: options.deadlineMs },
  );
}

module.exports = { createWorkspaceOriginalReader };
