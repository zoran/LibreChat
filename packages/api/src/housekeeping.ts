/** Explicit, inert Housekeeping entry. Composition owns resources, trust, placement and activation. */
export { createHousekeepingRuntime } from './housekeeping/runtime';
export type {
  HousekeepingRuntime,
  HousekeepingRuntimeDependencies,
  HousekeepingObservation,
  HousekeepingDrain,
  HousekeepingClock,
} from './housekeeping/runtime';
export { createHousekeepingHandlers } from './housekeeping/handlers';
export type {
  HousekeepingHandlers,
  HousekeepingHandlerDependencies,
  HousekeepingStep,
} from './housekeeping/handlers';
export { HOUSEKEEPING_POLICY } from './housekeeping/config';

export { createHousekeepingApplication } from './housekeeping/application';
export type {
  HousekeepingApplication,
  HousekeepingApplicationDependencies,
} from './housekeeping/application';
export {
  setupGracefulShutdown,
  requestGracefulShutdown,
  registerShutdownTask,
  getShutdownSignal,
  getRemainingShutdownMs,
  isShutdownInProgress,
} from './app/shutdown';
export { instrumentMongooseQueryMetrics } from './app/metrics';
export { optionalEnabled } from './utils/common';
export { createManagedS3Client } from './storage/s3/managedClient';
export { createManagedS3Storage, getManagedS3Provider } from './storage/s3/managed';
export { createManagedUploadCleanup } from './uploads/cleanup';

export { createFileCleanupPort } from './files/lifecycleCleanup';
export type { FileCleanupComposition } from './files/lifecycleCleanup';
export { purgeFileSourceCheckpoints } from './agents/checkpointer';
export { resolveCheckpointerConfig } from './agents/checkpoints/config';

export { createManagedFilePurge } from './files/rag/managed';
export type {
  ManagedFilePurge,
  ManagedFilePurgeOptions,
  ManagedFilePurgeOperations,
  TrustedManagedFileConfiguration,
} from './files/rag/managed';
export { parseManagedFileDeploymentConfiguration } from './files/rag/configuration';
export type { ManagedFileDeploymentExpectations } from './files/rag/configuration';
export { loadManagedFileDeploymentConfiguration } from './files/rag/deployment';
export type { ManagedFileDeploymentOptions } from './files/rag/deployment';
