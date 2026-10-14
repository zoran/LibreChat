const { withAuthRequest, authUserUpdate } = require('~/server/services/LegacyAuthMaintenance');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const { SystemRoles } = require('librechat-data-provider');
const { Strategy: JwtStrategy, ExtractJwt } = require('passport-jwt');
const {
  AGENT_TRIGGER_SCOPE,
  isTokenRetired,
  continueAfterBearerRetirement,
  getAuthMode,
  getAuthSelection,
  validateEmailCodeBearer,
  validateBrowserBearer,
  guestUploadTransitionEnabled,
  getEmailCodeSettings,
} = require('@librechat/api');
const models = require('~/models');
const { getUserById, updateUser } = models;
const { authWrite } = require('~/server/services/LegacyAuthMaintenance');

const AGENT_TRIGGER_ADMISSION_PATHS = ['/api/agents/chat/agents', '/api/agents/chat/steer/deliver'];

/** A trigger-scoped bearer is deliberately useless outside the two internal
 * admission routes that the execution host calls. */
function isAgentTriggerAdmissionRequest(req) {
  if (req?.method !== 'POST' || req?.headers?.['x-lc-agent-trigger'] !== '1') {
    return false;
  }
  try {
    const pathname = new URL(req.originalUrl ?? req.url ?? '', 'http://localhost').pathname;
    return AGENT_TRIGGER_ADMISSION_PATHS.some((path) => pathname.endsWith(path));
  } catch {
    return false;
  }
}

// JWT strategy
const jwtLogin = () =>
  new JwtStrategy(
    {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: process.env.JWT_SECRET,
      passReqToCallback: true,
    },
    (req, payload, done) =>
      withAuthRequest(req, async () => {
        try {
          if (payload?.scope === AGENT_TRIGGER_SCOPE && !isAgentTriggerAdmissionRequest(req)) {
            done(null, false, { message: 'Agent trigger token is not valid for this endpoint' });
            return;
          }
          const user = await runAsSystem(() =>
            getUserById(
              payload?.id,
              '-password -__v -totpSecret -backupCodes +agentTriggerDeletionStartedAt',
            ),
          );
          if (user?.agentTriggerDeletionStartedAt != null) {
            done(null, false, {
              message: 'Account deletion is in progress',
              code: 'ACCOUNT_DELETION_IN_PROGRESS',
            });
            return;
          }
          if (user) {
            const mode = getAuthMode();
            if (mode !== 'default' || payload?.authMethod === 'email_code') {
              const trustedTrigger =
                payload?.scope === AGENT_TRIGGER_SCOPE &&
                isAgentTriggerAdmissionRequest(req) &&
                !user.authDisabled &&
                ((mode === 'transition' && user.provider === 'browser' && !user.tenantId) ||
                  (user.provider === 'email_code' &&
                    user.emailVerified &&
                    user.tenantId === getEmailCodeSettings().tenantId));
              if (trustedTrigger) {
                // This existing service grant is restricted to trigger admission, never employee uploads.
                req.authenticationClass = 'service';
                req.tenantId = user.tenantId;
              } else if (
                user.provider === 'browser' &&
                mode === 'transition' &&
                !user.tenantId &&
                payload?.provider === 'browser' &&
                ['guest', undefined].includes(getAuthSelection(req))
              ) {
                if (guestUploadTransitionEnabled()) {
                  const identity = await runAsSystem(() =>
                    validateBrowserBearer(payload, req, models),
                  );
                  if (!identity || identity.user.id !== String(user._id)) {
                    done(null, false, { code: 'AUTH_SESSION_REQUIRED' });
                    return;
                  }
                  req.browserGrant = identity.grant;
                  user.role = identity.user.role;
                }
                req.authenticationClass = 'guest';
                delete req.tenantId;
              } else {
                const identity = await validateEmailCodeBearer(payload, models);
                if (!identity || identity.user.id !== String(user._id)) {
                  done(null, false, { code: 'AUTH_SESSION_REQUIRED' });
                  return;
                }
                req.emailCodeGrant = identity.grant;
                req.authenticationClass = 'verified-email';
                user.role = identity.user.role;
                user.tenantId = identity.grant.tenantId;
                // Never inherit a browser header or old pre-auth tenant on verified paths.
                req.tenantId = identity.grant.tenantId;
                if (
                  ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) &&
                  !req.originalUrl?.includes('/api/auth/')
                ) {
                  await authWrite(() => models.touchEmailCodeSession(identity.grant, new Date()));
                }
              }
            }
            return await continueAfterBearerRetirement(
              user,
              { issuedAt: payload?.iat, issuedAtMs: payload?.issuedAtMs },
              'jwt',
              payload?.id,
              done,
              (message) => logger.warn(message),
              async () => {
                user.id = user._id.toString();
                /** Absent on the full doc means local user; null skips getUserPrincipals' fallback lookup */
                user.idOnTheSource ??= null;
                if (!user.role) {
                  user.role = SystemRoles.USER;
                  await runAsSystem(() => authUserUpdate(updateUser, user.id, { role: user.role }));
                }
                done(null, user);
              },
              isTokenRetired,
            );
          } else {
            logger.warn('[jwtLogin] JwtStrategy => no user found: ' + payload?.id);
            done(null, false);
          }
        } catch (err) {
          done(err, false);
        }
      }).catch(done),
  );

module.exports = jwtLogin;
