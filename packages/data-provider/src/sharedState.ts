import { z } from 'zod';

/** Bootstrap transport contract: evaluated before asynchronous application YAML/cache loading. */
const host = z
  .string()
  .min(1)
  .max(253)
  .refine(
    (value) =>
      z.string().ip().safeParse(value).success ||
      value
        .split('.')
        .every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label)),
  );
export const sharedStateSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('uri') }).strict(),
  z
    .object({
      mode: z.literal('sentinel'),
      endpoints: z
        .array(z.object({ host, port: z.number().int().min(1).max(65535) }).strict())
        .min(1)
        .max(16)
        .refine(
          (seeds) =>
            new Set(seeds.map((s) => `${s.host.toLowerCase()}:${s.port}`)).size === seeds.length,
        ),
      name: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
      username: z.string().min(1),
      password: z.string().min(1),
      caPath: z.string().min(1),
      sentinelUsername: z.string().min(1),
      sentinelPassword: z.string().min(1),
      sentinelCaPath: z.string().min(1),
    })
    .strict(),
]);
export type SharedState = z.infer<typeof sharedStateSchema>;

/** Errors deliberately exclude environment values, including credentials. */
export function parseSharedState(env: Record<string, string | undefined>): SharedState {
  if (env.REDIS_CONNECTION_MODE === undefined || env.REDIS_CONNECTION_MODE === 'uri') {
    return { mode: 'uri' };
  }
  try {
    if (
      env.REDIS_CONNECTION_MODE !== 'sentinel' ||
      !['true', '1'].includes(env.USE_REDIS ?? '') ||
      (env.USE_REDIS_STREAMS !== undefined && !['true', '1'].includes(env.USE_REDIS_STREAMS)) ||
      env.REDIS_URI ||
      ['true', '1'].includes(env.USE_REDIS_CLUSTER ?? '')
    ) {
      throw new Error();
    }
    return sharedStateSchema.parse({
      mode: 'sentinel',
      endpoints: JSON.parse(env.REDIS_SENTINEL_ENDPOINTS ?? ''),
      name: env.REDIS_SENTINEL_NAME,
      username: env.REDIS_USERNAME,
      password: env.REDIS_PASSWORD,
      caPath: env.REDIS_CA,
      sentinelUsername: env.REDIS_SENTINEL_USERNAME,
      sentinelPassword: env.REDIS_SENTINEL_PASSWORD,
      sentinelCaPath: env.REDIS_SENTINEL_CA,
    });
  } catch {
    throw new Error('Invalid shared-state transport configuration');
  }
}
