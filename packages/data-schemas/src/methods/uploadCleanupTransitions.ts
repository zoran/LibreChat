/** uploadCleanupTransitions owns the existing Upload terminal and accounting transitions. */
import { readHistoricalUploadSecuritySettlement } from 'librechat-data-provider';
import type { UploadErrorCode, UploadCleanupProof } from 'librechat-data-provider';
import type { StoredUpload, GlobalState, UploadStore } from './uploadManagementStore';
import {
  hasUploadStorageCompletion,
  hasUploadActorClosure,
  hasUploadAcceptedFileAck,
} from './uploadCleanupReceipts';
import {
  hasCompleteUploadSecurityExecution,
  recordUploadSecuritySettlement,
} from './uploadManagement.security';
import { hasStoppedUploadPromotion } from './uploadManagementIntake';
import { reject } from './uploadManagementStore';
/** Existing terminal/accounting transitions shared by the two actual Upload cleanup owners. */
export function createUploadCleanupTransitions(store: UploadStore): {
  terminal(
    row: StoredUpload,
    global: GlobalState,
    state: StoredUpload['state'],
    code?: UploadErrorCode,
  ): void;
  applyCleanup(row: StoredUpload, proof: UploadCleanupProof, global: GlobalState): void;
} {
  function terminal(
    row: StoredUpload,
    global: GlobalState,
    state: StoredUpload['state'],
    code?: UploadErrorCode,
  ): void {
    row.state = state;
    row.error = code;
    row.pendingBytes =
      row.writeBinding?.version === 2 && row.acceptedAt == null && !hasUploadStorageCompletion(row)
        ? row.declaredBytes
        : 0;
    row.generation++;
    store.releaseQueue(row, global);
    row.cleanupPending =
      row.slot != null || row.stagingHeld || row.originalBytes > 0 || row.textBytes > 0;
    if (row.attemptGeneration == null && row.acceptedAt == null) {
      global.originalBytes -= row.originalBytes;
      global.objectBytes -= row.originalBytes;
      row.originalBytes = 0;
      row.originalRemoved = true;
      row.cleanupPending = false;
    }
  }
  function applyCleanup(row: StoredUpload, proof: UploadCleanupProof, global: GlobalState): void {
    const settlement =
      proof.securitySettlement === undefined
        ? undefined
        : readHistoricalUploadSecuritySettlement(proof.securitySettlement);
    if (settlement === null) reject('invalid_request');
    if ((row.workerGeneration ?? row.generation) !== proof.generation) reject('lease_lost');
    if (settlement) recordUploadSecuritySettlement(row, settlement);
    if (row.securityExecution && !hasCompleteUploadSecurityExecution(row)) reject('not_ready');
    if (!hasStoppedUploadPromotion(row)) reject('not_ready');
    if (!proof.writerStopped) reject('not_ready');
    row.writerStopped = true;
    if (row.slot && ['transferring', 'processing'].includes(row.state))
      terminal(row, global, 'failed', 'processing_failed');
    delete row.slot;
    delete row.leaseExpiresAt;
    if (proof.localCopiesAbsent) row.stagingHeld = false;
    const removeOriginal = row.acceptedAt == null || ['deleted', 'expired'].includes(row.state);
    if (
      proof.originalAbsent &&
      removeOriginal &&
      (row.attemptGeneration == null ||
        ((hasUploadStorageCompletion(row) || hasUploadAcceptedFileAck(row)) &&
          hasUploadActorClosure(row)))
    ) {
      global.originalBytes -= row.originalBytes;
      global.objectBytes -= row.originalBytes;
      row.originalBytes = 0;
      row.originalRemoved = true;
    }
    if (
      proof.textAndHistoryRemoved &&
      row.state !== 'ready' &&
      (row.attemptGeneration == null ||
        ((hasUploadStorageCompletion(row) || hasUploadAcceptedFileAck(row)) &&
          hasUploadActorClosure(row)))
    ) {
      global.textBytes -= row.textBytes;
      row.textBytes = 0;
      row.textRemoved = true;
    }
    row.cleanupPending =
      row.stagingHeld ||
      (removeOriginal && (row.originalBytes > 0 || row.textBytes > 0)) ||
      (!!row.cleanupCustody?.request && row.cleanupCustody.consumed === undefined);
    if (
      row.writeBinding?.version === 2 &&
      hasUploadStorageCompletion(row) &&
      row.originalBytes === 0 &&
      row.textBytes === 0
    )
      row.pendingBytes = 0;
    // Preserve the original Intake acknowledgement before a later processing claim replaces
    // the active worker fields. This bit never attests that later processing generation.
    if (
      row.intake?.generation === proof.generation &&
      row.attemptGeneration === proof.generation &&
      row.intake.worker?.hostId === row.worker?.hostId &&
      row.intake.worker?.instanceId === row.worker?.instanceId &&
      proof.localCopiesAbsent &&
      row.promotion?.receipt?.outcome !== 'unknown' &&
      row.promotion?.state !== 'writing'
    )
      row.intake.cleanupAcknowledged = true;
  }
  return { terminal, applyCleanup };
}
