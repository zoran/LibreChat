const express = require('express');
const { createAdminSkillsSyncAccess, createAdminSkillsSyncHandlers } = require('@librechat/api');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { hasCapability, requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const { upsertSkillSyncCredential, deleteSkillSyncCredential } = require('~/models');
const { getGitHubSkillSyncRunnerForRequest } = require('~/server/services/Skills/sync');
const { getAppConfig } = require('~/server/services/Config');
const configMiddleware = require('~/server/middleware/config/app');
const { requireManagedIntake } = require('~/server/middleware/requireManagedIntake');

const router = express.Router();
const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);

const syncAccess = createAdminSkillsSyncAccess({
  getAppConfig,
  hasCapability,
});

const handlers = createAdminSkillsSyncHandlers({
  getRunner: getGitHubSkillSyncRunnerForRequest,
  upsertCredential: upsertSkillSyncCredential,
  deleteCredential: deleteSkillSyncCredential,
});

router.use(
  requireJwtAuth,
  requireAdminAccess,
  configMiddleware,
  syncAccess.attachBaseSkillSyncConfig,
);

router.get(
  '/sync/status',
  requireManagedIntake,
  syncAccess.requireReadSkills,
  syncAccess.attachCredentialReadAccess,
  handlers.getSyncStatus,
);
router.post(
  '/sync/run',
  requireManagedIntake,
  syncAccess.requireSyncRunCapability,
  handlers.runSync,
);
router.put(
  '/sync/credentials/:credentialKey',
  syncAccess.requirePlatformManageSkills,
  handlers.setCredential,
);
router.delete(
  '/sync/credentials/:credentialKey',
  syncAccess.requirePlatformManageSkills,
  handlers.deleteCredential,
);

module.exports = router;
