const mongoose = require('mongoose');
const { createMethods } = require('@librechat/data-schemas');
const {
  matchModelName,
  findMatchingPattern,
  isDeploymentSkillId,
  createMessageBudgetReader,
  getConfiguredAdministratorPolicy,
} = require('@librechat/api');
const getLogStores = require('~/cache/getLogStores');

const messageBudget = createMessageBudgetReader();
const configuredAdministratorPolicy = getConfiguredAdministratorPolicy();

const methods = createMethods(mongoose, {
  configuredAdministratorPolicy,
  matchModelName,
  findMatchingPattern,
  isExternalSkillId: isDeploymentSkillId,
  getCache: getLogStores,
  getMCPAppMessageBudget: messageBudget.getBudget,
});

const seedDatabase = async () => {
  await methods.assertConfiguredAdministratorPolicyPresence(configuredAdministratorPolicy);
  await methods.initializeRoles();
  await methods.seedDefaultRoles();
  await methods.ensureDefaultCategories();
  await methods.seedSystemGrants();
  if (configuredAdministratorPolicy) {
    await methods.reconcileConfiguredAdministrators(configuredAdministratorPolicy);
  }
};

module.exports = {
  ...methods,
  initializeMessageBudget: messageBudget.initialize,
  seedDatabase,
};
