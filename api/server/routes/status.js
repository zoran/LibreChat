const { ioredisClient, recordStatusOperation } = require('@librechat/api');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { readStatusSnapshot, STATUS_METRICS } = require('librechat-data-provider');
const { requireJwtAuth } = require('~/server/middleware');
const { requireCapability, hasCapability } = require('~/server/middleware/roles/capabilities');
const { createStatusService } = require('~/server/services/status/service');
const { createStatusRouter } = require('~/server/services/status/router');

module.exports = createStatusRouter({
  requireJwtAuth,
  requireCapability,
  hasCapability,
  accessAdmin: SystemCapabilities.ACCESS_ADMIN,
  record: recordStatusOperation,
  getSnapshot: createStatusService({
    client: ioredisClient,
    readStatusSnapshot,
    STATUS_METRICS,
    record: recordStatusOperation,
  }),
});
