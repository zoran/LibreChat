import { randomUUID } from 'node:crypto';
import type { UploadParserExecution } from 'librechat-data-provider';
import { DocumentProcessingError } from '../../files/documents/managed';

export type ParserAttempt = {
  execution: UploadParserExecution;
  mediaType: string;
  state: 'prepared' | 'running' | 'fenced' | 'finished';
  deadlineMonotonicMs: number;
  retainedUntilMs: number;
};

/** Bounded local execution receipts, never a shared job queue or admission authority. */
export class ParserReceipts {
  readonly instanceId: string = randomUUID();
  private readonly records = new Map<string, ParserAttempt>();
  constructor(
    private readonly options: {
      wallMs: number;
      capacity?: number;
      retentionMs?: number;
      now?: () => number;
      monotonic?: () => number;
    },
  ) {
    for (const [value, ceiling] of [
      [options.wallMs, 60_000],
      [options.capacity ?? 256, 256],
      [options.retentionMs ?? 600_000, 600_000],
    ]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > ceiling)
        throw new Error('Invalid parser receipt limit');
    }
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }

  private monotonic() {
    return (this.options.monotonic ?? (() => performance.now()))();
  }

  private prune() {
    for (const [id, record] of this.records) {
      if (record.state === 'prepared' && this.remainingMs(record) <= 0) this.finish(record, true);
      if (
        (record.state === 'fenced' || record.state === 'finished') &&
        record.retainedUntilMs <= this.monotonic()
      ) {
        this.records.delete(id);
      }
    }
  }

  prepare(attemptId: string, mediaType: string): UploadParserExecution {
    this.prune();
    const existing = this.records.get(attemptId);
    if (existing) {
      if (
        existing.state !== 'prepared' ||
        existing.mediaType !== mediaType ||
        this.remainingMs(existing) <= 0
      ) {
        throw new DocumentProcessingError('cancelled');
      }
      return { ...existing.execution };
    }
    if (this.records.size >= (this.options.capacity ?? 256))
      throw new DocumentProcessingError('parser_unavailable');
    const execution = {
      attemptId,
      instanceId: this.instanceId,
      expiresAt: new Date(this.now() + this.options.wallMs).toISOString(),
    };
    this.records.set(attemptId, {
      execution,
      mediaType,
      state: 'prepared',
      deadlineMonotonicMs: this.monotonic() + this.options.wallMs,
      retainedUntilMs: Infinity,
    });
    return { ...execution };
  }

  find(execution: UploadParserExecution): ParserAttempt | undefined {
    this.prune();
    const record = this.records.get(execution.attemptId);
    if (
      !record ||
      execution.instanceId !== this.instanceId ||
      execution.expiresAt !== record.execution.expiresAt
    )
      return undefined;
    return record;
  }

  start(execution: UploadParserExecution): ParserAttempt | undefined {
    const record = this.find(execution);
    if (!record || record.state !== 'prepared' || this.remainingMs(record) <= 0) return undefined;
    record.state = 'running';
    return record;
  }

  /** Mark before waiting for the child; every delayed execute sees this fence. */
  fence(record: ParserAttempt): void {
    record.state = 'fenced';
  }

  /** Call only after no child can remain. Active fenced records never expire early. */
  finish(record: ParserAttempt, fenced = false): void {
    record.state = fenced || record.state === 'fenced' ? 'fenced' : 'finished';
    record.retainedUntilMs = this.monotonic() + (this.options.retentionMs ?? 600_000);
  }

  remainingMs(record: ParserAttempt): number {
    return Math.max(
      0,
      Math.min(
        Date.parse(record.execution.expiresAt) - this.now(),
        record.deadlineMonotonicMs - this.monotonic(),
      ),
    );
  }
}
