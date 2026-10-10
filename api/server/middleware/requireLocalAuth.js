const { withAuthRequest } = require('~/server/services/LegacyAuthMaintenance');
const passport = require('passport');
const { logger } = require('@librechat/data-schemas');

const requireLocalAuth = (req, res, next) =>
  withAuthRequest(
    req,
    () =>
      new Promise((resolve, reject) => {
        passport.authenticate('local', (err, user, info) => {
          try {
            if (err) {
              logger.error('[requireLocalAuth] Error at passport.authenticate:', err);
              return next(err);
            }
            if (!user) {
              logger.debug('[requireLocalAuth] Error: No user');
              return res.status(404).send(info);
            }
            if (info && info.message) {
              logger.debug('[requireLocalAuth] Error: ' + info.message);
              return res.status(422).send({ message: info.message });
            }
            req.user = user;
            next();
          } catch (error) {
            reject(error);
          } finally {
            resolve();
          }
        })(req, res, (error) => {
          try {
            next(error);
          } finally {
            resolve();
          }
        });
      }),
  ).catch(next);

module.exports = requireLocalAuth;
