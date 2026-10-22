/** Private source witnesses: the native host, never HTTP metadata, owns their provenance. */
import type { ClientSession } from 'mongoose';
import type { FileOwnerScope } from './file';

export type CheckpointSourceInput = Readonly<{
  messages: readonly Readonly<{
    conversationId: string;
    messageId: string;
    expectedVersion: number | null;
  }>[];
  fileIds: readonly string[];
}>;

/** Captured expiry is immutable envelope provenance, never the current File identity. */
export type CheckpointSourceBinding = Readonly<{
  version: 2;
  owner: Readonly<{ userId: string; tenantId: string | null }>;
  files: readonly Readonly<{ fileId: string; bindingSha256: string; expiresAt: string }>[];
  messages: readonly Readonly<{
    conversationId: string;
    messageId: string;
    capturedVersion: number | null;
    bodySha256: string;
    sourceFileIds: readonly string[];
    expiresAt: string;
  }>[];
  expiresAt: string;
  bindingSha256: string;
}>;

export type CapturedCheckpointMessage = {
  conversationId: string;
  messageId: string;
  text?: string;
  content?: unknown[];
  quotes?: string[];
};

export type CapturedCheckpointSources = {
  binding: CheckpointSourceBinding;
  messages: CapturedCheckpointMessage[];
};

export type CheckpointSourceMethods = {
  captureCheckpointSources(
    owner: FileOwnerScope,
    input: CheckpointSourceInput,
    session: ClientSession,
  ): Promise<CapturedCheckpointSources>;
  fenceCheckpointSources(
    owner: FileOwnerScope,
    binding: CheckpointSourceBinding,
    session: ClientSession,
  ): Promise<void>;
};
