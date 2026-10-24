const express = require('express');
const { generateCheckAccess, createApiKeyHandlers } = require('@librechat/api');
const { PermissionTypes, Permissions } = require('librechat-data-provider');
const {
  getAgentApiKeyById,
  createAgentApiKey,
  deleteAgentApiKey,
  listAgentApiKeys,
  getRoleByName,
} = require('~/models');
const { requireJwtAuth } = require('~/server/middleware');
const {
  ownAuthHandler,
  authTrack,
  authCache,
  authPersistence,
} = require('~/server/services/LegacyAuthMaintenance');

const router = express.Router();

const handlers = createApiKeyHandlers({
  createAgentApiKey: (data) => authTrack(() => createAgentApiKey(data, authPersistence)),
  listAgentApiKeys,
  deleteAgentApiKey: (id, userId) =>
    authTrack(() => deleteAgentApiKey(id, userId, authPersistence)),
  getAgentApiKeyById,
});

const checkRemoteAgentsUse = generateCheckAccess({
  permissionType: PermissionTypes.REMOTE_AGENTS,
  permissions: [Permissions.USE],
  getRoleByName: (name, fields) =>
    authTrack(() =>
      getRoleByName(name, fields, { persistence: authPersistence, observeCache: authCache }),
    ),
});

router.post(
  '/',
  requireJwtAuth,
  ownAuthHandler(checkRemoteAgentsUse),
  ownAuthHandler(handlers.createApiKey),
);

router.get(
  '/',
  requireJwtAuth,
  ownAuthHandler(checkRemoteAgentsUse),
  ownAuthHandler(handlers.listApiKeys),
);

router.get(
  '/:id',
  requireJwtAuth,
  ownAuthHandler(checkRemoteAgentsUse),
  ownAuthHandler(handlers.getApiKey),
);

router.delete(
  '/:id',
  requireJwtAuth,
  ownAuthHandler(checkRemoteAgentsUse),
  ownAuthHandler(handlers.deleteApiKey),
);

module.exports = router;
