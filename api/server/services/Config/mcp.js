const { createMCPToolCacheService, MCPServersRegistry } = require('@librechat/api');
const {
  getCachedTools,
  updateCachedGlobalTools,
  setCachedToolsWithinGlobalLock,
  getCachedAppServerTools,
  setCachedAppServerTools,
  setCachedToolsIfCurrent,
  getMCPToolsCacheGeneration,
  renewMCPToolsCacheGeneration,
  getNextAppToolsPublicationRevision,
  runMCPToolPublication,
} = require('./getCachedTools');

const {
  syncStaticTools,
  mergeAppTools,
  cacheMCPServerTools,
  updateMCPServerTools,
  getMCPServerTools,
} = createMCPToolCacheService({
  getCachedTools,
  updateCachedGlobalTools,
  setCachedTools: setCachedToolsWithinGlobalLock,
  setCachedToolsIfCurrent,
  getCachedAppServerTools,
  setCachedAppServerTools,
  getServerConfig: (serverName, userId) =>
    MCPServersRegistry.getInstance().getServerConfig(serverName, userId),
  getAllServerConfigs: () => MCPServersRegistry.getInstance().getAllServerConfigs(),
  isAppServerConfig: (serverName, effectiveConfig) =>
    MCPServersRegistry.getInstance().isAppServerConfig(serverName, effectiveConfig),
});

module.exports = {
  syncStaticTools: (...args) => runMCPToolPublication(() => syncStaticTools(...args)),
  mergeAppTools: (...args) => runMCPToolPublication(() => mergeAppTools(...args)),
  getMCPServerTools: (...args) => runMCPToolPublication(() => getMCPServerTools(...args)),
  cacheMCPServerTools: (...args) => runMCPToolPublication(() => cacheMCPServerTools(...args)),
  updateMCPServerTools: (...args) => runMCPToolPublication(() => updateMCPServerTools(...args)),
  getMCPToolsCacheGeneration,
  renewMCPToolsCacheGeneration,
  getNextAppToolsPublicationRevision,
};
