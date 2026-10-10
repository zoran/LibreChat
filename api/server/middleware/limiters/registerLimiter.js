const { ownAuthHandler, authPersistence } = require('~/server/services/LegacyAuthMaintenance');
const rateLimit = require('express-rate-limit');
const { ViolationTypes } = require('librechat-data-provider');
const { limiterCache, removePorts } = require('@librechat/api');
const { logViolation } = require('~/cache');

const { REGISTER_WINDOW = 60, REGISTER_MAX = 5, REGISTRATION_VIOLATION_SCORE: score } = process.env;
const windowMs = REGISTER_WINDOW * 60 * 1000;
const max = REGISTER_MAX;
const windowInMinutes = windowMs / 60000;
const message = `Too many accounts created, please try again after ${windowInMinutes} minutes`;

const handler = async (req, res) => {
  const type = ViolationTypes.REGISTRATIONS;
  const errorMessage = {
    type,
    max,
    windowInMinutes,
  };

  await logViolation(req, res, type, errorMessage, score);
  return res.status(429).json({ message });
};

const limiterOptions = {
  windowMs,
  max,
  handler: ownAuthHandler(handler),
  keyGenerator: removePorts,
  store: limiterCache('register_limiter', authPersistence),
};

const registerLimiter = rateLimit(limiterOptions);

module.exports = Object.assign(ownAuthHandler(registerLimiter), registerLimiter);
