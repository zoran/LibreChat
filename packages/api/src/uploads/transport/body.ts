import path from 'node:path';
import { createReadStream } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { finished } from 'node:stream/promises';
import { mkdir, open, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  isUploadPrincipal,
  readUploadSecurityInspection,
  matchesUploadSecurityApproval,
} from 'librechat-data-provider';
import type {
  UploadPrincipal,
  UploadWorker,
  UploadLease,
  UploadByteLease,
  UploadErrorCode,
  UploadSecurityApproval,
  UploadSecuritySubject,
} from 'librechat-data-provider';
import type { Request, RequestHandler } from 'express';
import type {
  StoragePort,
  UploadAttemptPort,
  UploadAttemptRegistration,
  UploadSecurityPort,
} from '../contract';
import type { UploadManagement } from '../management';
import { UploadManagementError, isUploadManagementError } from '../errors';
import { attemptOriginalPath, uploadAttemptId } from '../processing/paths';
import { createOriginalIntegrity } from '../storage/integrity';

const MAX_BYTES = 30 * 1024 * 1024;
const MAX_SLICE = 64 * 1024;

export type RawUploadObservation =
  | { kind: 'received'; bytes: number }
  | { kind: 'accepted'; bytes: number }
  | {
      kind: 'stage';
      stage: 'wait' | 'transfer' | 'storage' | 'request';
      seconds: number;
      outcome: 'success' | 'failure' | 'cancelled';
    };

export type RawUploadBodyDependencies = {
  management: Pick<
    UploadManagement,
    'get' | 'claimTransfer' | 'renew' | 'accept' | 'fail' | 'cancel' | 'confirmCleanup'
  >;
  principal(request: Request): Promise<UploadPrincipal>;
  storage: StoragePort;
  security: UploadSecurityPort;
  worker: UploadWorker;
  stagingRoot: string;
  /** Shared durable byte allocator; no local fallback can mint a new allowance. */
  claimBytes(lease: UploadLease, requestedBytes: number): Promise<UploadByteLease | null>;
  completeBytes(lease: UploadLease, generation: number): Promise<void>;
  deadlineMs?: number;
  idleMs?: number;
  now?: () => number;
  attempts?: UploadAttemptPort;
  observe?(observation: RawUploadObservation): void | Promise<void>;
};

export function validateRawUploadHeaders(headers: Request['headers'], declaredBytes: number): void {
  if (
    headers['content-type']?.trim().toLowerCase() !== 'application/octet-stream' ||
    (headers['content-encoding'] !== undefined && headers['content-encoding'] !== 'identity') ||
    headers['content-range'] !== undefined ||
    headers.range !== undefined ||
    headers['content-disposition'] !== undefined
  ) {
    throw new UploadManagementError('invalid_request');
  }
  const length = headers['content-length'];
  if (
    length !== undefined &&
    (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) !== declaredBytes)
  ) {
    throw new UploadManagementError('size_mismatch');
  }
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 1 || declaredBytes > MAX_BYTES) {
    throw new UploadManagementError('size_mismatch');
  }
}

/** Register before express.json/urlencoded. The handler never installs a body parser. */
export function createRawUploadBodyHandler(deps: RawUploadBodyDependencies): RequestHandler {
  const deadlineMs = deps.deadlineMs ?? 120_000;
  const idleMs = deps.idleMs ?? 15_000;
  if (
    !path.isAbsolute(deps.stagingRoot) ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > 120_000 ||
    !Number.isSafeInteger(idleMs) ||
    idleMs < 1 ||
    idleMs > 15_000
  ) {
    throw new Error('Invalid upload transport configuration');
  }
  const now = deps.now ?? Date.now;
  return async (req, res) => {
    const startedAt = performance.now();
    let outcome: 'success' | 'failure' | 'cancelled' = 'failure';
    let stage: { name: 'wait' | 'transfer' | 'storage'; startedAt: number } | undefined;
    const observe = (event: RawUploadObservation) => {
      try {
        void Promise.resolve(deps.observe?.(event)).catch(() => undefined);
      } catch {
        /* diagnostics cannot affect admission or cleanup */
      }
    };
    const finishStage = (result: typeof outcome) => {
      if (!stage) return;
      const current = stage;
      stage = undefined;
      observe({
        kind: 'stage',
        stage: current.name,
        seconds: Math.max(0, performance.now() - current.startedAt) / 1_000,
        outcome: result,
      });
    };
    req.pause();
    const controller = new AbortController();
    const { signal } = controller;
    let lease: UploadLease | null = null;
    let directory: string | undefined;
    let stagingAttempted = false;
    let accepted = false;
    let storing = false;
    let inspectionPending = false;
    // No scanner work exists before dispatch; afterward only its validated attestation can settle it.
    let scannerSettled = true;
    let storageOutcome: 'not_started' | 'durable' | 'unknown' | 'absent' = 'not_started';
    let errorCode: UploadErrorCode = 'unavailable';
    let admittedPrincipal: UploadPrincipal | undefined;
    let waitingOperation: { principal: UploadPrincipal; id: string } | undefined;
    let heartbeat: Promise<void> | undefined;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let renewStopped = false;
    let registration: UploadAttemptRegistration | undefined;
    let claimPending = false;
    let claimUncertain = false;
    let idleTimer: NodeJS.Timeout | undefined;
    const timedOut = () => {
      const code = inspectionPending ? 'security_uninspectable' : 'unavailable';
      if (inspectionPending) errorCode = code;
      if (!res.destroyed && !res.headersSent) {
        res.setHeader('connection', 'close');
        res.status(inspectionPending ? 422 : 408).json({ code });
      }
      controller.abort();
      // Also close an unread body while a bounded repository call is settling.
      // A late claim remains fenced/cleaned below; timeout never implies stop proof.
      if (!lease) req.destroy();
    };
    const timeout = setTimeout(timedOut, deadlineMs);
    timeout.unref();
    const disconnected = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once('aborted', disconnected);
    res.once('close', disconnected);
    const refreshIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(timedOut, idleMs);
      idleTimer.unref();
    };
    // Reuse the identity adapter at phase/heartbeat boundaries, never per byte chunk.
    // An authorization read is not an atomic fence with the subsequent storage commit.
    const verifyPrincipal = async (): Promise<void> => {
      signal.throwIfAborted();
      try {
        const current = await deps.principal(req);
        if (
          !admittedPrincipal ||
          !isUploadPrincipal(current) ||
          current.authentication !== admittedPrincipal.authentication ||
          current.tenantId !== admittedPrincipal.tenantId ||
          current.userId !== admittedPrincipal.userId
        ) {
          throw new UploadManagementError('unauthorized');
        }
      } catch {
        errorCode = 'unauthorized';
        const failure = new UploadManagementError('unauthorized');
        controller.abort(failure);
        throw failure;
      }
      signal.throwIfAborted();
    };
    const renew = () => {
      heartbeat = (async () => {
        try {
          if (lease && !signal.aborted) {
            await verifyPrincipal();
            lease = await deps.management.renew(lease);
          }
        } catch {
          if (!signal.aborted) errorCode = 'lease_lost';
          controller.abort();
        }
        if (!signal.aborted && !renewStopped) heartbeatTimer = setTimeout(renew, 5_000);
      })();
    };
    async function* budgeted(source: AsyncIterable<Uint8Array>, receiving = false) {
      for await (const chunk of source) {
        if (receiving) observe({ kind: 'received', bytes: chunk.byteLength });
        signal.throwIfAborted();
        refreshIdle();
        let offset = 0;
        while (offset < chunk.byteLength) {
          signal.throwIfAborted();
          const requested = Math.min(MAX_SLICE, chunk.byteLength - offset);
          const grant = await deps.claimBytes(lease!, requested);
          signal.throwIfAborted();
          if (!grant) {
            await delay(50, undefined, { signal });
            continue;
          }
          if (
            !Number.isSafeInteger(grant.bytes) ||
            grant.bytes < 1 ||
            grant.bytes > requested ||
            !Number.isFinite(Date.parse(grant.expiresAt)) ||
            Date.parse(grant.expiresAt) <= now()
          ) {
            throw new UploadManagementError('lease_lost');
          }
          try {
            yield chunk.subarray(offset, offset + grant.bytes);
          } finally {
            await deps.completeBytes(lease!, grant.generation);
          }
          offset += grant.bytes;
        }
      }
    }
    try {
      registration = deps.attempts?.begin(() => {
        controller.abort();
        req.destroy();
      });
      const principal = Object.freeze({ ...(await deps.principal(req)) });
      admittedPrincipal = principal;
      const id = req.params.id;
      if (typeof id !== 'string' || req.body !== undefined || req.readableEnded) {
        throw new UploadManagementError('invalid_request');
      }
      const operation = await deps.management.get(principal, id);
      validateRawUploadHeaders(req.headers, operation.declaredBytes);
      signal.throwIfAborted();
      waitingOperation = { principal, id };
      stage = { name: 'wait', startedAt: performance.now() };
      while (!lease) {
        signal.throwIfAborted();
        await verifyPrincipal();
        claimPending = true;
        lease = await deps.management.claimTransfer(principal, id, deps.worker);
        claimPending = false;
        if (!lease) await delay(1_000, undefined, { signal });
      }
      finishStage('success');
      registration?.bind(lease);
      signal.throwIfAborted();
      await verifyPrincipal();
      const attemptId = uploadAttemptId(lease);
      const filePath = attemptOriginalPath(deps.stagingRoot, attemptId);
      const attemptDirectory = path.dirname(filePath);
      // Root creation is composition-owned; no operation can choose or traverse its path.
      stagingAttempted = true;
      await mkdir(attemptDirectory, { mode: 0o700 });
      directory = attemptDirectory;
      // Bind the receipt to received bytes, before the existing staging-to-storage read.
      const receivedIntegrity = createOriginalIntegrity(operation.declaredBytes);
      const file = await open(filePath, 'wx', 0o600);
      heartbeatTimer = setTimeout(renew, 5_000);
      refreshIdle();
      const abortReceive = () => req.destroy();
      signal.addEventListener('abort', abortReceive, { once: true });
      let bytes = 0;
      stage = { name: 'transfer', startedAt: performance.now() };
      try {
        signal.throwIfAborted();
        for await (const chunk of budgeted(req, true)) {
          bytes += chunk.byteLength;
          if (bytes > operation.declaredBytes) throw new UploadManagementError('size_mismatch');
          receivedIntegrity.update(chunk);
          // Await every write: disk/rate pressure propagates through the request stream.
          let written = 0;
          while (written < chunk.byteLength) {
            const result = await file.write(chunk, written, chunk.byteLength - written);
            if (result.bytesWritten === 0) throw new Error('Upload staging unavailable');
            written += result.bytesWritten;
          }
        }
        if (bytes !== operation.declaredBytes) throw new UploadManagementError('size_mismatch');
        await file.sync();
      } finally {
        signal.removeEventListener('abort', abortReceive);
        await file.close();
      }
      const integrity = receivedIntegrity.finish();
      finishStage('success');
      clearTimeout(idleTimer);
      signal.throwIfAborted();
      await verifyPrincipal();
      const subject: UploadSecuritySubject = Object.freeze({
        tenantId: principal.tenantId,
        userId: principal.userId,
        operationId: lease.operationId,
        transferGeneration: lease.generation,
        mediaType: operation.mediaType,
        bytes,
        sha256: integrity.sha256,
      });
      let securityApproval: UploadSecurityApproval;
      errorCode = 'security_uninspectable';
      let securityRejected = false;
      try {
        if (typeof deps.security?.inspect !== 'function')
          throw new UploadManagementError('security_uninspectable');
        // The extra byte detects an appended file while keeping this independent read bounded.
        const scan = createReadStream(filePath, {
          start: 0,
          end: bytes,
          highWaterMark: MAX_SLICE,
          signal,
        });
        const scanClosed = finished(scan, { cleanup: true }).catch(() => undefined);
        const scanIntegrity = createOriginalIntegrity(bytes);
        let scanComplete = false;
        const scanBody = (async function* () {
          for await (const chunk of scan) {
            signal.throwIfAborted();
            scanIntegrity.update(chunk);
            yield chunk;
          }
          signal.throwIfAborted();
          if (scanIntegrity.finish().sha256 !== integrity.sha256)
            throw new UploadManagementError('security_uninspectable');
          scanComplete = true;
        })();
        let abortInspection!: () => void;
        const aborted = new Promise<never>((_resolve, reject) => {
          abortInspection = () => reject(new UploadManagementError('security_uninspectable'));
          signal.addEventListener('abort', abortInspection, { once: true });
        });
        try {
          signal.throwIfAborted();
          inspectionPending = true;
          const inspection = Promise.resolve()
            .then(() => {
              signal.throwIfAborted();
              scannerSettled = false;
              return deps.security.inspect({ subject, body: scanBody, signal });
            })
            .finally(() => {
              inspectionPending = false;
            });
          const result = await Promise.race([inspection, aborted]);
          signal.throwIfAborted();
          const inspected = readUploadSecurityInspection(result);
          if (!inspected) throw new UploadManagementError('security_uninspectable');
          scannerSettled = true;
          const { decision } = inspected;
          if (decision.decision !== 'approved') {
            securityRejected = decision.decision === 'rejected';
            throw new UploadManagementError(
              securityRejected ? 'security_rejected' : 'security_uninspectable',
            );
          }
          if (!scanComplete) throw new UploadManagementError('security_uninspectable');
          // Keep the checked receipt independent of later mutation by an adapter.
          securityApproval = Object.freeze({
            ...decision,
            subject: Object.freeze({ ...decision.subject }),
            coverage: Object.freeze({ ...decision.coverage }),
          });
          if (
            !matchesUploadSecurityApproval(
              securityApproval,
              subject,
              deps.security.policySha256,
              now(),
            )
          )
            throw new UploadManagementError('security_uninspectable');
        } finally {
          signal.removeEventListener('abort', abortInspection);
          scan.destroy();
          await scanClosed;
        }
      } catch {
        if (signal.aborted) signal.throwIfAborted();
        if (securityRejected) throw new UploadManagementError('security_rejected');
        throw new UploadManagementError('security_uninspectable');
      }
      await verifyPrincipal();
      if (
        !matchesUploadSecurityApproval(securityApproval, subject, deps.security.policySha256, now())
      )
        throw new UploadManagementError('security_uninspectable');
      errorCode = 'unavailable';
      storing = true;
      storageOutcome = 'unknown';
      stage = { name: 'storage', startedAt: performance.now() };
      // Apply the same aggregate traffic budget to S3 egress: staging never creates a burst.
      const stream = createReadStream(filePath, { highWaterMark: MAX_SLICE, signal });
      let receipt;
      try {
        receipt = await deps.storage.put({
          lease,
          filename: operation.filename,
          mediaType: operation.mediaType,
          bytes,
          integrity,
          body: budgeted(stream),
          signal,
        });
      } finally {
        stream.destroy();
      }
      storageOutcome = receipt.outcome;
      if (receipt.outcome !== 'durable') throw new UploadManagementError('storage_uncertain');
      finishStage('success');
      signal.throwIfAborted();
      renewStopped = true;
      clearTimeout(heartbeatTimer);
      await heartbeat;
      signal.throwIfAborted();
      await verifyPrincipal();
      const result = await deps.management.accept(principal, id, lease, receipt, securityApproval);
      accepted = true;
      outcome = 'success';
      observe({ kind: 'accepted', bytes: receipt.bytes });
      if (!res.destroyed && !res.headersSent) res.status(202).json(result);
    } catch (error) {
      outcome = signal.aborted ? 'cancelled' : 'failure';
      finishStage(outcome);
      claimUncertain = claimPending && !isUploadManagementError(error);
      if (isUploadManagementError(error)) errorCode = error.code;
      else if (storing) errorCode = 'storage_uncertain';
      if (lease && !accepted) await deps.management.fail(lease, errorCode).catch(() => undefined);
      if (!lease && waitingOperation && signal.aborted) {
        await deps.management
          .cancel(waitingOperation.principal, waitingOperation.id)
          .catch(() => undefined);
      }
      if (!res.destroyed && !res.headersSent) {
        // Do not drain a rejected body into user space or reuse its connection.
        res.setHeader('connection', 'close');
        let status = 503;
        if (errorCode === 'unauthorized') status = 401;
        else if (errorCode === 'forbidden') status = 403;
        else if (errorCode === 'not_found') status = 404;
        else if (errorCode === 'not_ready') status = 409;
        else if (errorCode === 'invalid_request' || errorCode === 'size_mismatch') status = 400;
        else if (errorCode === 'security_rejected' || errorCode === 'security_uninspectable')
          status = 422;
        res.status(status).json({ code: errorCode });
      }
    } finally {
      controller.abort();
      renewStopped = true;
      clearTimeout(timeout);
      clearTimeout(idleTimer);
      clearTimeout(heartbeatTimer);
      await heartbeat;
      req.off('aborted', disconnected);
      res.off('close', disconnected);
      // Do not release shared reservations here: unknown storage/DB outcomes need
      // the existing durable cleanup owner. Scanner promise settlement or local input
      // removal cannot establish that its execution and transient copies are gone.
      let localCopiesAbsent = !stagingAttempted;
      if (directory) {
        try {
          await rm(directory, { recursive: true, force: true });
          localCopiesAbsent = true;
        } catch {
          /* cleanup owner retries */
        }
      }
      if (lease && localCopiesAbsent && storageOutcome !== 'unknown' && scannerSettled) {
        await deps.management
          .confirmCleanup({
            operationId: lease.operationId,
            generation: lease.generation,
            writerStopped: true,
            localCopiesAbsent: true,
            originalAbsent: storageOutcome === 'not_started' || storageOutcome === 'absent',
            textAndHistoryRemoved: false,
          })
          .catch(() => undefined);
      }
      // A directory we failed to create may belong to another invocation. Its
      // writer identity stays unknown; recovery must not adopt and remove it.
      registration?.settle({
        writerStopped:
          storageOutcome !== 'unknown' &&
          scannerSettled &&
          !claimUncertain &&
          !(stagingAttempted && !directory),
        localCopiesAbsent,
        storageOutcome,
      });
      observe({
        kind: 'stage',
        stage: 'request',
        seconds: Math.max(0, performance.now() - startedAt) / 1_000,
        outcome,
      });
    }
  };
}
