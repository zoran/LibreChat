/** managed.ts owns browser-safe deployment schema only; secrets/files are resolved by server composition. */
import { z } from 'zod';

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const hasControl = (value: string): boolean =>
  Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
const absoluteFile = z
  .string()
  .min(2)
  .max(4096)
  .refine(
    (value) =>
      value.startsWith('/') &&
      !value.endsWith('/') &&
      !value.includes('\\') &&
      !hasControl(value) &&
      !value.split('/').some((part) => part === '.' || part === '..'),
    'An absolute file path without traversal or controls is required',
  );
const endpoint = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => {
    if (hasControl(value) || /[ @?#]/.test(value)) return false;
    try {
      const parsed = new URL(value);
      return (
        parsed.protocol === 'https:' &&
        !parsed.username &&
        !parsed.password &&
        parsed.pathname === '/' &&
        !parsed.search &&
        !parsed.hash
      );
    } catch {
      return false;
    }
  }, 'An HTTPS root endpoint without userinfo, query or fragment is required');
const duration = z.number().int().positive().max(2147483647);

export const managedUploadsConfigSchema = z
  .object({
    storage: z
      .object({
        kind: z.literal('nas-s3'),
        uid: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        endpoint,
        region: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
          .default('us-east-1'),
        bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
        credentialsFile: absoluteFile,
        trust: z.discriminatedUnion('mode', [
          z
            .object({
              mode: z.literal('exact-certificate'),
              certificateFile: absoluteFile,
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .strict(),
          z.object({ mode: z.literal('ca-hostname'), caFile: absoluteFile.optional() }).strict(),
        ]),
        requestTimeoutMs: z.number().int().min(1000).max(300000).default(10000),
      })
      .strict(),
    antivirus: z
      .object({ signatureMaxAgeMs: z.number().int().min(1000).max(86400000).default(86400000) })
      .strict()
      .default({}),
    health: z
      .object({
        intervalMs: duration.default(60000),
        maxAgeMs: duration.default(90000),
        requiredHosts: z
          .array(identifier)
          .min(1)
          .max(64)
          .refine((hosts) => new Set(hosts).size === hosts.length, 'Required hosts must be unique'),
      })
      .strict()
      .refine(
        (value) => value.maxAgeMs >= value.intervalMs,
        'Health freshness must cover its interval',
      ),
  })
  .strict();

export type ManagedUploadsConfig = z.infer<typeof managedUploadsConfigSchema>;
