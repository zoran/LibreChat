const express = require('express');
const {
  ownAuthHandler,
  authTrack,
  authCache,
  authUserUpdate,
  authPersistence,
} = require('~/server/services/LegacyAuthMaintenance');
const { CacheKeys } = require('librechat-data-provider');
const {
  createToolFavoritesHandlers,
  createPinnedOrderHandlers,
  invalidateCachedAuthUserDoc,
} = require('@librechat/api');
const {
  updateFavoritesController,
  getFavoritesController,
} = require('~/server/controllers/FavoritesController');
const {
  getSkillStatesController,
  updateSkillStatesController,
} = require('~/server/controllers/SkillStatesController');
const { requireJwtAuth } = require('~/server/middleware');
const { getLogStores } = require('~/cache');
const {
  getToolFavorites,
  addToolFavorite,
  removeToolFavorite,
  getUserById,
  updateUser,
} = require('~/models');

const router = express.Router();

const toolFavorites = createToolFavoritesHandlers({
  getToolFavorites,
  // Retain preflight reads without treating an expected capacity refusal as a failed write.
  addToolFavorite: (params) => authTrack(() => addToolFavorite(params, authPersistence)),
  removeToolFavorite: (params) => authTrack(() => removeToolFavorite(params, authPersistence)),
});

const authUserDocCacheStore = getLogStores(CacheKeys.AUTH_USER_DOC);
const ownedAuthUserDocCacheStore = authUserDocCacheStore && authCache(authUserDocCacheStore);
const pinnedOrder = createPinnedOrderHandlers({
  getUserById,
  updateUser: (...args) => authUserUpdate(updateUser, ...args),
  invalidateCachedAuthUserDoc: (userId) =>
    authTrack(() => invalidateCachedAuthUserDoc(ownedAuthUserDocCacheStore, { userId })),
});

router.get('/favorites/tools', requireJwtAuth, ownAuthHandler(toolFavorites.listToolFavorites));
router.put(
  '/favorites/tools/:itemType/:itemId',
  requireJwtAuth,
  ownAuthHandler(toolFavorites.addToolFavorite),
);
router.delete(
  '/favorites/tools/:itemType/:itemId',
  requireJwtAuth,
  ownAuthHandler(toolFavorites.removeToolFavorite),
);
router.get('/favorites', requireJwtAuth, ownAuthHandler(getFavoritesController));
router.post('/favorites', requireJwtAuth, ownAuthHandler(updateFavoritesController));
router.get('/pinned-order', requireJwtAuth, ownAuthHandler(pinnedOrder.getPinnedOrder));
router.post('/pinned-order', requireJwtAuth, ownAuthHandler(pinnedOrder.updatePinnedOrder));
router.get('/skills/active', requireJwtAuth, ownAuthHandler(getSkillStatesController));
router.post('/skills/active', requireJwtAuth, ownAuthHandler(updateSkillStatesController));

module.exports = router;
