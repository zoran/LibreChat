import type { CheckpointTuple } from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';
import { LIBRECHAT_CHECKPOINT_OWNER_KEY, LIBRECHAT_LEGACY_CHECKPOINT_KEY } from './saver';

/**
 * LangGraph reserves `checkpoint_ns` for nested graph namespaces and forcibly
 * resets a non-empty value to `''` for every root invocation. Carry LibreChat's
 * immutable generation scope on a private configurable key instead; the saver
 * adapter below maps it into Mongo's storage namespace without changing the
 * graph-visible conversation `thread_id`.
 */
export const LIBRECHAT_CHECKPOINT_NAMESPACE_KEY = '__librechat_checkpoint_ns';
/** Marks a checkpoint write as belonging to an isolated event-actor attempt.
 * Unlike ordinary clean chat exits, these exits are durable candidate heads. */
export const LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY = '__librechat_event_actor_invocation_id';

const CHECKPOINT_NAMESPACE_SEPARATOR = '|';

export function generationCheckpointNamespace(config: RunnableConfig): string | undefined {
  const value = config.configurable?.[LIBRECHAT_CHECKPOINT_NAMESPACE_KEY];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Prefix every root/subgraph storage namespace with the immutable generation. */
export function toStorageCheckpointConfig(config: RunnableConfig): RunnableConfig {
  const generationNamespace = generationCheckpointNamespace(config);
  if (!generationNamespace) {
    return config;
  }
  const graphNamespace =
    typeof config.configurable?.checkpoint_ns === 'string' ? config.configurable.checkpoint_ns : '';
  return {
    ...config,
    configurable: {
      ...config.configurable,
      checkpoint_ns:
        graphNamespace === ''
          ? generationNamespace
          : `${generationNamespace}${CHECKPOINT_NAMESPACE_SEPARATOR}${graphNamespace}`,
    },
  };
}

/** Restore the namespace LangGraph supplied while retaining the private scope. */
export function fromStorageCheckpointConfig(
  storedConfig: RunnableConfig,
  requestedConfig: RunnableConfig,
): RunnableConfig {
  const generationNamespace = generationCheckpointNamespace(requestedConfig);
  if (!generationNamespace) {
    return storedConfig;
  }
  const graphNamespace =
    typeof requestedConfig.configurable?.checkpoint_ns === 'string'
      ? requestedConfig.configurable.checkpoint_ns
      : '';
  return {
    ...storedConfig,
    configurable: {
      ...storedConfig.configurable,
      ...(requestedConfig.configurable?.[LIBRECHAT_CHECKPOINT_OWNER_KEY] && {
        [LIBRECHAT_CHECKPOINT_OWNER_KEY]:
          requestedConfig.configurable[LIBRECHAT_CHECKPOINT_OWNER_KEY],
      }),
      ...(requestedConfig.configurable?.[LIBRECHAT_LEGACY_CHECKPOINT_KEY] && {
        [LIBRECHAT_LEGACY_CHECKPOINT_KEY]:
          storedConfig.configurable?.[LIBRECHAT_LEGACY_CHECKPOINT_KEY] ??
          requestedConfig.configurable[LIBRECHAT_LEGACY_CHECKPOINT_KEY],
      }),
      thread_id: requestedConfig.configurable?.thread_id ?? storedConfig.configurable?.thread_id,
      checkpoint_ns: graphNamespace,
      [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: generationNamespace,
    },
  };
}

export function fromStorageCheckpointTuple(
  tuple: CheckpointTuple,
  requestedConfig: RunnableConfig,
): CheckpointTuple {
  return {
    ...tuple,
    config: fromStorageCheckpointConfig(tuple.config, requestedConfig),
    ...(tuple.parentConfig && {
      parentConfig: fromStorageCheckpointConfig(tuple.parentConfig, requestedConfig),
    }),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Mongo filter matching a generation's root and every nested graph namespace. */
export function generationNamespaceFilter(
  checkpointNamespace: string,
): string | { $regex: string } {
  if (checkpointNamespace === '') {
    return '';
  }
  return {
    $regex: `^${escapeRegExp(checkpointNamespace)}(?:\\${CHECKPOINT_NAMESPACE_SEPARATOR}|$)`,
  };
}
