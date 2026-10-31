/** Full current AV tuples for inert external-engine ports; real shared readers/worker guards remain active. */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readUploadAntivirusCustody } from 'librechat-data-provider';
import type {
  UploadAntivirusApproval,
  UploadAntivirusReceipt,
  UploadSecurityExecution,
  UploadSecuritySubject,
} from 'librechat-data-provider';
import type { AntivirusRuntime, AntivirusSession } from './antivirus-runtime';

const representative = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/response-budget.json'), 'utf8'),
);

/** Representative public wire data is rebound to the exact test subject and original cutoff. */
export function antivirusCustodyFixture(
  subject: UploadSecuritySubject,
  expiresAt: string,
  now = Date.now(),
) {
  const value = JSON.parse(JSON.stringify(representative.execution.antivirus));
  value.subject = JSON.parse(JSON.stringify(subject));
  value.expiresAt = expiresAt;
  value.dailyPublishedAt = new Date(now - 1000).toISOString();
  value.original.id = randomUUID();
  value.original.startTicks = '3456';
  const custody = readUploadAntivirusCustody(value);
  if (!custody) throw new Error('Current public AV fixture contract rejected');
  return custody;
}

/** Expected external-engine join only; this fixture never attests a real process or filesystem. */
export function antivirusReceiptFixture(
  execution: UploadSecurityExecution,
): UploadAntivirusReceipt {
  if (execution.version !== 3) throw new Error('Legacy execution has no current AV custody');
  return {
    custody: JSON.parse(JSON.stringify(execution.antivirus)),
    state: 'retired',
    originalProcessJoined: true,
    ownedTransientDataRemoved: true,
  };
}

/** Actual readers validate this expected private observation; it is never real engine evidence. */
export function antivirusApprovalFixture(
  execution: UploadSecurityExecution,
  now = Date.now(),
): UploadAntivirusApproval {
  if (execution.version !== 3) throw new Error('Legacy execution has no current AV custody');
  return {
    custody: JSON.parse(JSON.stringify(execution.antivirus)),
    engineVersion: representative.inspection.decision.antivirus.engineVersion,
    readyObservedAt: new Date(now).toISOString(),
    cleanAt: new Date(now).toISOString(),
  };
}

/** Only the ClamD/process boundary is inert; no domain validation function is replaced. */
export function createInertAntivirusFixture(
  options: { now?: () => number; requireBinding?: boolean } = {},
) {
  const now = options.now ?? Date.now;
  const events: string[] = [];
  const sessions = new Set<AntivirusSession>();
  let bound = !options.requireBinding,
    known = true,
    malicious = false,
    closed = false,
    preparations = 0;
  const runtime: AntivirusRuntime = {
    async initialise() {
      if (closed) throw new Error('Inert engine was already closed');
    },
    available: () => !closed,
    pending: () => sessions.size,
    deadline: (value) => value,
    async prepare(subject, expiresAt) {
      if (closed) throw new Error('Inert engine was already closed');
      const custody = antivirusCustodyFixture(subject, expiresAt, now());
      events.push('prepare');
      preparations++;
      let active = false;
      const session: AntivirusSession = {
        custody,
        async activate() {
          events.push('activate');
          if (!bound) throw new Error('Original was not durably bound');
          active = true;
        },
        async inspect() {
          events.push('scan');
          if (!active || now() >= Date.parse(expiresAt)) throw new Error('Original was not ready');
          return malicious
            ? { verdict: 'malicious', reason: 'malware' }
            : {
                verdict: 'clean',
                approval: {
                  custody: JSON.parse(JSON.stringify(custody)),
                  engineVersion: representative.inspection.decision.antivirus.engineVersion,
                  readyObservedAt: new Date(now()).toISOString(),
                  cleanAt: new Date(now()).toISOString(),
                },
              };
        },
        async retire() {
          events.push('retire');
          active = false;
          if (known) sessions.delete(session);
          return {
            custody: JSON.parse(JSON.stringify(custody)),
            state: known ? 'retired' : 'unknown',
            originalProcessJoined: known,
            ownedTransientDataRemoved: known,
          };
        },
      };
      sessions.add(session);
      return session;
    },
    async drain() {
      closed = true;
      await Promise.all([...sessions].map((session) => session.retire()));
      return { complete: sessions.size === 0 };
    },
  };
  return {
    runtime,
    events,
    bind: () => {
      bound = true;
    },
    unknown: () => {
      known = false;
    },
    settle: () => {
      known = true;
    },
    malware: () => {
      malicious = true;
    },
    preparations: () => preparations,
  };
}
