const { withAuthRequest } = require('~/server/services/LegacyAuthMaintenance');
const passport = require('passport');

const requireLdapAuth = (req, res, next) =>
  withAuthRequest(
    req,
    () =>
      new Promise((resolve, reject) => {
        passport.authenticate('ldapauth', (err, user, info) => {
          try {
            if (err) {
              console.log({
                title: '(requireLdapAuth) Error at passport.authenticate',
                parameters: [{ name: 'error', value: err }],
              });
              return next(err);
            }
            if (!user) {
              console.log({
                title: '(requireLdapAuth) Error: No user',
              });
              return res.status(404).send(info);
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
module.exports = requireLdapAuth;
