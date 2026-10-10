import { logger } from '@librechat/data-schemas';
import type { SkillSyncConfig } from 'librechat-data-provider';
import type { GitHubSkillSyncRunner } from './github';
import type { ApplicationWorkPort } from '~/app';
import { registerShutdownTask } from '~/app/shutdown';

const NODE_TIMER_MAX_MS = 2147483647;
const SKILL_SYNC_MIN_INTERVAL_MINUTES = 5;
export const SKILL_SYNC_MAX_TIMER_INTERVAL_MINUTES: number = Math.floor(NODE_TIMER_MAX_MS / 60_000);

type MaybePromise<T> = T | Promise<T>;

export type GitHubSkillSyncScheduler = ApplicationWorkPort & {
  stop: () => void;
};

function normalizeIntervalMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 60;
  }
  return Math.min(
    SKILL_SYNC_MAX_TIMER_INTERVAL_MINUTES,
    Math.max(SKILL_SYNC_MIN_INTERVAL_MINUTES, Math.floor(value)),
  );
}

function getSources(config: SkillSyncConfig | undefined) {
  const sources = config?.github?.sources;
  return Array.isArray(sources) ? sources : [];
}

export function startGitHubSkillSyncScheduler(params: {
  getConfig: () => MaybePromise<SkillSyncConfig | undefined>;
  runner: GitHubSkillSyncRunner;
}): GitHubSkillSyncScheduler {
  let stopped = false;
  let pausedBy: string | undefined;
  let pending = 0;
  let nextAt = 0;
  const observe = async (run: () => Promise<void>) => {
    pending++;
    try {
      await run();
    } finally {
      pending--;
    }
  };
  let timer: NodeJS.Timeout | undefined;

  const getConfig = async (): Promise<SkillSyncConfig | undefined> => {
    try {
      return await params.getConfig();
    } catch (error) {
      logger.error('[GitHubSkillSync] Failed to load scheduler config:', error);
      return undefined;
    }
  };

  const scheduleNext = (config: SkillSyncConfig | undefined) => {
    if (stopped) {
      return;
    }
    const delayMs = normalizeIntervalMinutes(config?.github?.intervalMinutes) * 60 * 1000;
    nextAt = Date.now() + delayMs;
    if (pausedBy) return;
    timer = setTimeout(tick, delayMs);
    timer.unref?.();
  };

  const runIfEnabled = async () => {
    const config = await getConfig();
    const github = config?.github;
    if (stopped || pausedBy || !github?.enabled || getSources(config).length === 0) {
      return config;
    }
    try {
      await params.runner.runOnce();
    } catch (error) {
      logger.error('[GitHubSkillSync] Scheduled run failed:', error);
    }
    return getConfig();
  };

  async function tick() {
    if (stopped || pausedBy) return;
    await observe(async () => {
      const config = await runIfEnabled();
      scheduleNext(config);
    });
  }

  const scheduler: GitHubSkillSyncScheduler = {
    pauseAdmissions(requestId) {
      if (!requestId || (pausedBy && pausedBy !== requestId)) return false;
      pausedBy = requestId;
      if (timer) clearTimeout(timer);
      timer = undefined;
      return true;
    },
    resumeAdmissions(requestId) {
      if (pausedBy !== requestId || stopped) return false;
      pausedBy = undefined;
      if (pending > 0) return true;
      timer = setTimeout(tick, Math.max(0, nextAt - Date.now()));
      timer.unref?.();
      return true;
    },
    async getMaintenanceCensus(requestId) {
      return {
        admissionClosed: stopped || (!!requestId && pausedBy === requestId),
        queuedContinuations: pending,
        pendingWrites: pending,
        complete: pausedBy == null || pausedBy === requestId,
      };
    },
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };

  void observe(async () => {
    const config = await getConfig();
    if (
      !stopped &&
      !pausedBy &&
      config?.github?.enabled &&
      config.github.runOnStartup &&
      getSources(config).length > 0
    ) {
      await params.runner.runOnce().catch((error) => {
        logger.error('[GitHubSkillSync] Scheduled startup run failed:', error);
      });
    }
    scheduleNext(config);
  });

  registerShutdownTask('github skill sync scheduler', () => {
    scheduler.stop();
  });

  return scheduler;
}
