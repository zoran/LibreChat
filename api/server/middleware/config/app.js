const { logger } = require('@librechat/data-schemas');
const { getAppConfigOptionsFromUser, resolveStrictAppConfig } = require('@librechat/api');
const { getAppConfig } = require('~/server/services/Config');
const { withAuthRequest } = require('~/server/services/LegacyAuthMaintenance');

const configMiddleware = async (req, res, next) => {
  try {
    req.config = await getAppConfig(getAppConfigOptionsFromUser(req.user));

    next();
  } catch (error) {
    logger.error('Config middleware error:', {
      error: error.message,
      userRole: req.user?.role,
      path: req.path,
    });

    try {
      req.config = await getAppConfig({ tenantId: req.user?.tenantId });
      next();
    } catch (fallbackError) {
      logger.error('Fallback config middleware error:', fallbackError);
      next(fallbackError);
    }
  }
};

/** The same resolution, without the fallback; `resolveStrictAppConfig` owns that choice. */
const strictConfigMiddleware = async (req, res, next) => {
  try {
    req.config = await resolveStrictAppConfig(getAppConfig, req.user);
    next();
  } catch (error) {
    logger.error('Strict config middleware error:', {
      error: error.message,
      userRole: req.user?.role,
      path: req.path,
    });
    next(error);
  }
};

module.exports = (req, res, next) => withAuthRequest(req, () => configMiddleware(req, res, next));
module.exports.strictConfigMiddleware = (req, res, next) =>
  withAuthRequest(req, () => strictConfigMiddleware(req, res, next));
