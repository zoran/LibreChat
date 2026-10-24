const mongoose = require('mongoose');
const { createModels } = require('@librechat/data-schemas');
const { connectDb, getDbConnector } = require('./connect');
const { modelBootstrap } = getDbConnector();

// createModels MUST run before requiring indexSync.
// indexSync.js captures mongoose.models.Message and mongoose.models.Conversation
// at module load time. If those models are not registered first, all MeiliSearch
// sync operations will silently fail on every startup.
modelBootstrap.construct(() => createModels(mongoose));

const indexSync = require('./indexSync');

module.exports = { connectDb, indexSync, modelBootstrap };
