/** Private original-upload status on the existing authenticated S3/SDK owner. */
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { GetObjectCommandOutput, S3Client } from '@aws-sdk/client-s3';
import type { ManagedUploadWriteBinding } from '@librechat/data-schemas';

const MAX_RESPONSE = 16384;
const FIELDS = [
  'version',
  'bucket',
  'key',
  'operationId',
  'generation',
  'bytes',
  'wholeSHA256',
  'mediaType',
  'originalDeadline',
].sort();
export function snapshotManagedWrite(value: ManagedUploadWriteBinding): ManagedUploadWriteBinding {
  const b = { ...value };
  if (
    Object.keys(b).sort().join(',') !== FIELDS.join(',') ||
    b.version !== 1 ||
    !b.bucket ||
    !b.key ||
    Buffer.byteLength(b.key) > 4096 ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(b.operationId) ||
    !/^[1-9][0-9]{0,14}$/.test(b.generation) ||
    !b.key.endsWith(`/${b.operationId}.${b.generation}__original`) ||
    !Number.isSafeInteger(b.bytes) ||
    b.bytes < 1 ||
    b.bytes > 30 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(b.wholeSHA256) ||
    typeof b.mediaType !== 'string' ||
    !b.mediaType ||
    /[\r\n\0]/.test(b.mediaType) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(b.originalDeadline) ||
    !Number.isFinite(Date.parse(b.originalDeadline)) ||
    new Date(b.originalDeadline).toISOString() !== b.originalDeadline
  )
    throw new Error('Invalid managed original binding');
  return Object.freeze(b);
}
export type ManagedOriginalStatus =
  | { state: 'unknown' | 'open' | 'sealed' }
  | { state: 'published'; etag: string };
function decodeStatus(raw: Buffer, binding: ManagedUploadWriteBinding): ManagedOriginalStatus {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  const value: Record<string, unknown> = JSON.parse(text);
  if (!value || Array.isArray(value) || typeof value !== 'object')
    throw new Error('Invalid managed status');
  const expected = {
    protocol: 1,
    bucket: binding.bucket,
    key: binding.key,
    generation: binding.generation,
    uploadRequestId: binding.operationId,
    declaredBytes: String(binding.bytes),
    contentSHA256: binding.wholeSHA256,
    mediaType: binding.mediaType,
    originalDeadline: binding.originalDeadline,
  };
  const published = value.state === 'published';
  const keys = [
    ...Object.keys(expected),
    'state',
    ...(published ? ['metadataSHA256', 'inventoryRevision', 'inventorySHA256', 'etag'] : []),
  ].sort();
  if (
    Object.keys(value).sort().join(',') !== keys.join(',') ||
    Object.entries(expected).some(([key, field]) => value[key] !== field) ||
    !['unknown', 'open', 'sealed', 'published'].includes(String(value.state))
  )
    throw new Error('Managed status binding mismatch');
  // Existing Go producer marshals one sorted scalar object. Exact canonical bytes reject
  // duplicate/aliased keys and hidden trailing data before any receipt becomes durable.
  const canonical = JSON.stringify(value, keys).replace(
    /[<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  if (canonical !== text) throw new Error('Noncanonical managed status');
  if (!published) return { state: value.state as 'unknown' | 'open' | 'sealed' };
  if (
    typeof value.metadataSHA256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.metadataSHA256) ||
    typeof value.inventorySHA256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.inventorySHA256) ||
    typeof value.inventoryRevision !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(value.inventoryRevision) ||
    typeof value.etag !== 'string' ||
    !/^[a-f0-9]{32}$/.test(value.etag)
  )
    throw new Error('Invalid managed publication proof');
  return { state: 'published', etag: `"${value.etag}"` };
}
type StatusOutput = GetObjectCommandOutput & { managedOriginal: ManagedOriginalStatus };
class ManagedUploadStatusCommand extends GetObjectCommand {
  constructor(binding: ManagedUploadWriteBinding, signal: AbortSignal) {
    super({ Bucket: binding.bucket, Key: binding.key });
    this.middlewareStack.add(
      (next) => async (args) => {
        const http = args.request as {
          protocol: string;
          hostname: string;
          method: string;
          query: Record<string, string>;
          headers: Record<string, string>;
          body?: unknown;
        };
        if (
          http.protocol !== 'https:' &&
          !(http.protocol === 'http:' && ['127.0.0.1', '::1', '[::1]'].includes(http.hostname))
        )
          throw new Error('Managed status requires authenticated transport');
        http.method = 'GET';
        http.query = { 'cortex-upload': '1' };
        delete http.body;
        http.headers['content-type'] = binding.mediaType;
        http.headers['x-amz-meta-operation'] = binding.operationId;
        http.headers['x-amz-meta-generation'] = binding.generation;
        http.headers['x-amz-meta-cortex-upload-bytes'] = String(binding.bytes);
        http.headers['x-amz-meta-cortex-upload-sha256'] = binding.wholeSHA256;
        http.headers['x-amz-meta-cortex-upload-deadline'] = binding.originalDeadline;
        signal.throwIfAborted();
        return next(args);
      },
      { step: 'build', name: 'managedUploadStatusRequest', priority: 'high' },
    );
    this.middlewareStack.add(
      (next) => async (args) => {
        const { response } = await next(args);
        const http = response as {
          statusCode: number;
          headers: Record<string, string>;
          body: unknown;
        };
        if (!(http.body instanceof Readable)) throw new Error('Invalid managed status body');
        const body = http.body;
        const abort = () => body.destroy(new Error('Managed status aborted'));
        const settled = finished(body, { cleanup: true }).catch(() => undefined);
        signal.addEventListener('abort', abort, { once: true });
        try {
          if (signal.aborted) abort();
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of body) {
            signal.throwIfAborted();
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > MAX_RESPONSE) throw new Error('Managed status too large');
            chunks.push(buffer);
          }
          if (
            http.statusCode !== 200 ||
            !/^application\/json(?:\s*;|$)/i.test(http.headers['content-type'] ?? '')
          )
            throw new Error('Managed status unavailable');
          const managedOriginal = decodeStatus(Buffer.concat(chunks), binding);
          return {
            response,
            output: { $metadata: { httpStatusCode: 200 }, managedOriginal } as StatusOutput,
          };
        } finally {
          signal.removeEventListener('abort', abort);
          body.destroy();
          await settled;
        }
      },
      { step: 'deserialize', name: 'deserializerMiddleware', override: true },
    );
  }
}
/** Read-only reconciliation has a fresh bounded read budget, retaining the expired original write binding. */
export async function observeManagedOriginal(
  client: S3Client,
  input: { binding: ManagedUploadWriteBinding; signal: AbortSignal },
): Promise<ManagedOriginalStatus> {
  const binding = snapshotManagedWrite(input.binding);
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(10000)]);
  try {
    signal.throwIfAborted();
    const result = (await client.send(new ManagedUploadStatusCommand(binding, signal), {
      abortSignal: signal,
    })) as StatusOutput;
    if (!result.managedOriginal) return { state: 'unknown' };
    return result.managedOriginal;
  } catch {
    return { state: 'unknown' };
  }
}
