/** Thin normal server wiring; private NAS/resource policy is owned by the typed platform. */
const { createUploadPlatformFromConfiguration } = require('@librechat/api');
const { runAsSystem } = require('@librechat/data-schemas');
const createUploadPlatform = (options) =>
  createUploadPlatformFromConfiguration({
    ...options,
    env: process.env,
    repository: {
      localReservations: (owner, now) =>
        runAsSystem(() => options.repository.localReservations(owner, now)),
    },
  });
module.exports = { createUploadPlatform };
