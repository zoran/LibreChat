/** Joins existing generation cleanup to File accounting. Owns no timer or quota ledger. */
import type {
  SourceReplayIdentity,
  SourceReplayIntent,
  SourceReplayQuota,
  SourceReplaySettlement,
} from './sourceBudget';
import {
  canReleaseSourceReplay,
  createSourceReplayIntent,
  SOURCE_REPLAY_LIMITS,
  SourceReplayError,
} from './sourceBudget';

export interface SourceReplayJob extends SourceReplayIdentity, SourceReplaySettlement {
  sourceReplayIntent?: SourceReplayIntent;
  sourceReplayHeld?: boolean;
  sourceRetentionRevokedAt?: number;
}

export interface SourceReplayStore {
  getJob(streamId: string): Promise<SourceReplayJob | null>;
  prepareSourceReplay(intent: SourceReplayIntent): Promise<SourceReplayIntent>;
  commitSourceReplay(intent: SourceReplayIntent): Promise<boolean>;
  listSourceReplayIntents(): Promise<SourceReplayIntent[]>;
  acknowledgeSourceReplayRelease(intent: SourceReplayIntent): Promise<boolean>;
  revokeSourceRetention(streamId: string, epoch: number): Promise<boolean>;
  purgeSourceRetention(streamId: string, epoch: number): Promise<boolean>;
}

export interface SourceReplayObservation {
  held: number;
  pendingCleanup: number;
  logicalReservedBytes: number;
  rejectedReason?: 'capacity' | 'unavailable' | 'unsupported';
}

export interface SourceReplayConfiguration {
  quota: SourceReplayQuota;
  observe?: (value: SourceReplayObservation) => void;
}

export class SourceReplayLifecycle {
  private sweeping?: Promise<void>;
  constructor(
    private readonly store: SourceReplayStore,
    private readonly purgeTransport: (
      streamId: string,
      epoch: number,
      options?: { silent?: boolean },
    ) => Promise<void>,
    private readonly config: SourceReplayConfiguration,
  ) {}

  async bind(
    streamId: string,
    epoch: number,
    sourceFileIds: readonly string[],
    sourceExpiresAt: number,
  ): Promise<SourceReplayIntent> {
    let prepared = false;
    try {
      const job = await this.store.getJob(streamId);
      if (
        !job ||
        job.createdAt !== epoch ||
        job.status !== 'running' ||
        sourceExpiresAt <= Date.now()
      )
        throw new SourceReplayError('document_source_unavailable');
      const intent = await this.store.prepareSourceReplay(
        createSourceReplayIntent(job, sourceFileIds, sourceExpiresAt),
      );
      prepared = true;
      const owner = { userId: intent.userId, tenantId: intent.tenantId };
      const reserve = async () => {
        const receipt = await this.config.quota.reserveFileSourceCopies(owner, {
          reservationId: intent.receipt.reservationId,
          sourceFileIds: intent.sourceFileIds,
          bytes: intent.receipt.bytes,
        });
        if (
          receipt.state !== 'held' ||
          receipt.fileId !== intent.receipt.fileId ||
          receipt.reservationId !== intent.receipt.reservationId ||
          receipt.bytes !== intent.receipt.bytes
        )
          throw new SourceReplayError('document_source_unavailable');
      };
      await reserve();
      if (!(await this.store.commitSourceReplay(intent)))
        throw new SourceReplayError('document_source_unavailable');
      // Makes File deletion racing the first reserve/bind visible before source publication.
      await reserve();
      const current = await this.store.getJob(streamId);
      if (
        !current ||
        current.createdAt !== epoch ||
        !current.sourceReplayHeld ||
        current.sourceRetentionRevokedAt != null ||
        current.sourceRetentionPurged
      )
        throw new SourceReplayError('document_source_unavailable');
      await this.observe();
      return intent;
    } catch (error) {
      if (prepared) await this.store.revokeSourceRetention(streamId, epoch).catch(() => false);
      const failure =
        error instanceof SourceReplayError
          ? error
          : new SourceReplayError('document_source_unavailable');
      let rejectedReason: SourceReplayObservation['rejectedReason'] = 'unavailable';
      if (failure.code === 'document_capacity_exceeded') rejectedReason = 'capacity';
      else if (failure.code === 'document_replay_unsupported') rejectedReason = 'unsupported';
      await this.observe(rejectedReason);
      throw failure;
    }
  }

  async settleCurrent(streamId: string, epoch: number): Promise<boolean> {
    const job = await this.store.getJob(streamId);
    if (!job || job.createdAt !== epoch || !job.sourceReplayIntent) return false;
    try {
      return await this.settle(job.sourceReplayIntent);
    } catch {
      return false;
    }
  }

  async sweep(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    const work = async () => {
      const intents = await this.store.listSourceReplayIntents();
      if (intents.length > SOURCE_REPLAY_LIMITS.epochs)
        throw new SourceReplayError('document_source_unavailable');
      for (const intent of intents) {
        try {
          await this.settle(intent);
        } catch {
          /* Existing cleanup retries the retained intent. */
        }
      }
      await this.observe();
    };
    this.sweeping = work().finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }

  private async settle(intent: SourceReplayIntent): Promise<boolean> {
    const job = await this.store.getJob(intent.streamId);
    if (
      !job ||
      job.userId !== intent.userId ||
      (job.tenantId ?? '') !== (intent.tenantId ?? '') ||
      !canReleaseSourceReplay(intent, { ...job, sourceRetentionPurged: true })
    )
      return false;
    // A different existing cleanup path may already have purged Redis. Local
    // buffers and transport reorder state still need the same idempotent purge.
    await this.purgeTransport(intent.streamId, intent.createdAt, { silent: true });
    if (!job.sourceRetentionPurged) {
      if (!(await this.store.purgeSourceRetention(intent.streamId, intent.createdAt))) return false;
    }
    const proof = await this.store.getJob(intent.streamId);
    if (!canReleaseSourceReplay(intent, proof)) return false;
    await this.config.quota.releaseFileSourceCopies(
      { userId: intent.userId, tenantId: intent.tenantId },
      intent.receipt,
    );
    return this.store.acknowledgeSourceReplayRelease(intent);
  }

  private async observe(rejectedReason?: SourceReplayObservation['rejectedReason']): Promise<void> {
    if (!this.config.observe) return;
    try {
      const intents = await this.store.listSourceReplayIntents();
      const jobs = await Promise.all(intents.map((intent) => this.store.getJob(intent.streamId)));
      this.config.observe({
        held: intents.length,
        pendingCleanup: jobs.filter(
          (job) => !job || !['running', 'requires_action'].includes(job.status),
        ).length,
        logicalReservedBytes: intents.length * SOURCE_REPLAY_LIMITS.reservedBytes,
        ...(rejectedReason ? { rejectedReason } : {}),
      });
    } catch {
      /* Observation failure cannot authorize work or acknowledge cleanup. */
    }
  }
}
