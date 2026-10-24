/** Nonsecret process observations. Only the actual resource factories register instance custody. */
import { canonicalManagedJson } from 'librechat-data-provider';
import type { UploadBackendBinding } from '../uploads/platform/backend';
import { parseUploadBackendBinding } from '../uploads/platform/backend';

export type InactiveStorageProvider = Readonly<{
  state: 'not-owned' | 'disabled' | 'uninitialized' | 'unavailable';
}>;
export type S3ClientCapture = Readonly<{
  instanceId: string;
  region: string;
  endpoint: string | null;
  forcePathStyle: boolean;
}>;
export type OrdinaryS3CommandCapture = Readonly<{
  instanceId: string;
  bucket: string;
  endpoint: string | null;
  forcePathStyle: boolean;
}>;
export type ManagedS3CommandCapture = Readonly<{
  instanceId: string;
  bucket: string;
}>;
export type UploadBackendCapture = Readonly<{
  instanceId: string;
  binding: Readonly<UploadBackendBinding>;
}>;
export type OrdinaryS3Provider =
  | InactiveStorageProvider
  | Readonly<{
      state: 'captured';
      client: S3ClientCapture;
      commands: OrdinaryS3CommandCapture;
    }>;
export type ManagedS3Provider =
  | InactiveStorageProvider
  | Readonly<{
      state: 'captured';
      client: S3ClientCapture;
      commands: ManagedS3CommandCapture;
      backend: UploadBackendCapture | null;
    }>;
export type StorageProviders = Readonly<{
  ordinaryS3: OrdinaryS3Provider;
  managedS3: ManagedS3Provider;
}>;

export const UNAVAILABLE_STORAGE_PROVIDERS: StorageProviders = Object.freeze({
  ordinaryS3: Object.freeze({ state: 'unavailable' }),
  managedS3: Object.freeze({ state: 'unavailable' }),
});
export const NOT_OWNED_STORAGE_PROVIDERS: StorageProviders = Object.freeze({
  ordinaryS3: Object.freeze({ state: 'not-owned' }),
  managedS3: Object.freeze({ state: 'not-owned' }),
});
const MAX_BYTES = 8192;
function invalid(): never {
  throw new Error('Storage provider observation unavailable');
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== 'string' || !keys.includes(key)) ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor || !('value' in descriptor) || !descriptor.enumerable;
    })
  )
    return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > max ||
    Buffer.byteLength(value, 'utf8') > max ||
    // eslint-disable-next-line no-control-regex -- Public identity fields exclude controls and whitespace.
    /[\s\x00-\x1f\x7f-\x9f]/u.test(value)
  )
    return invalid();
  canonicalManagedJson(value); // The existing scalar-Unicode owner rejects unpaired surrogates.
  return value;
}
function instance(value: unknown): string {
  const id = text(value, 36);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))
    return invalid();
  return id;
}
function endpoint(value: unknown): string | null {
  if (value === null) return null;
  const supplied = text(value, 2048);
  if (!/^https?:\/\/[^/?#@\\]+\/?$/i.test(supplied)) return invalid();
  const parsed = new URL(supplied);
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  )
    return invalid();
  return supplied; // Observation never normalizes the configuration used by the SDK.
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return invalid();
  return value;
}
function client(value: unknown): S3ClientCapture {
  const row = record(value, ['instanceId', 'region', 'endpoint', 'forcePathStyle']);
  return Object.freeze({
    instanceId: instance(row.instanceId),
    region: text(row.region, 128),
    endpoint: endpoint(row.endpoint),
    forcePathStyle: boolean(row.forcePathStyle),
  });
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** The platform uses this same parsed private copy for its real backend client and its observer. */
export function immutableUploadBackendBinding(
  value: UploadBackendBinding,
  expectedHosts: readonly string[],
): UploadBackendBinding {
  return freeze(parseUploadBackendBinding(value, expectedHosts));
}
function bindingText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) return invalid();
  canonicalManagedJson(value);
  return value; // Existing UploadBackendBinding parser retains its own identifier rules.
}
function backend(value: unknown): UploadBackendCapture | null {
  if (value === null) return null;
  const row = record(value, ['instanceId', 'binding']);
  const raw = row.binding;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  const binding = record(raw, [
    'schema',
    'deploymentId',
    'storeId',
    'bucket',
    'collection',
    'observers',
    'policy',
    'filesystems',
    ...(Object.prototype.hasOwnProperty.call(raw, 'emptyProvisionRevision')
      ? ['emptyProvisionRevision']
      : []),
  ]);
  if (
    !Array.isArray(binding.observers) ||
    binding.observers.length !== 2 ||
    !Array.isArray(binding.filesystems) ||
    binding.filesystems.length !== 4
  )
    return invalid();
  for (const item of binding.observers) {
    const observer = record(item, ['observer', 'name', 'uid']);
    for (const field of Object.values(observer)) bindingText(field, 128);
  }
  const hosts = binding.filesystems.map((item) => {
    const disk = record(item, ['hostId', 'pvUid', 'filesystemId']);
    for (const field of Object.values(disk)) bindingText(field, 128);
    return bindingText(disk.hostId, 128);
  });
  const policy = record(binding.policy, ['revision', 'sourceSha256', 'filers']);
  bindingText(policy.revision, 128);
  bindingText(policy.sourceSha256, 64);
  if (!Array.isArray(policy.filers) || policy.filers.length !== 2) return invalid();
  for (const item of policy.filers) {
    const filer = record(item, ['member', 'podUid', 'processId']);
    bindingText(filer.member, 128);
    bindingText(filer.podUid, 128);
    bindingText(filer.processId, 256);
  }
  for (const key of ['deploymentId', 'storeId', 'bucket', 'collection', 'emptyProvisionRevision']) {
    if (Object.prototype.hasOwnProperty.call(binding, key)) bindingText(binding[key], 128);
  }
  // This is structural wire validation, not a native host/Objects authority decision.
  const parsed = parseUploadBackendBinding(binding, hosts);
  if (canonicalManagedJson(binding) !== canonicalManagedJson(parsed)) return invalid();
  return freeze({ instanceId: instance(row.instanceId), binding: parsed });
}
function inactive(value: unknown): InactiveStorageProvider | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const state = Object.getOwnPropertyDescriptor(value, 'state');
  if (!state || !('value' in state)) return invalid();
  if (state.value === 'captured') return undefined;
  const row = record(value, ['state']);
  if (
    typeof row.state !== 'string' ||
    !['not-owned', 'disabled', 'uninitialized', 'unavailable'].includes(row.state)
  )
    return invalid();
  return Object.freeze({ state: row.state as InactiveStorageProvider['state'] });
}
function ordinary(value: unknown): OrdinaryS3Provider {
  const absent = inactive(value);
  if (absent) return absent;
  const row = record(value, ['state', 'client', 'commands']);
  const commands = record(row.commands, ['instanceId', 'bucket', 'endpoint', 'forcePathStyle']);
  return Object.freeze({
    state: 'captured',
    client: client(row.client),
    commands: Object.freeze({
      instanceId: instance(commands.instanceId),
      bucket: text(commands.bucket, 255),
      endpoint: endpoint(commands.endpoint),
      forcePathStyle: boolean(commands.forcePathStyle),
    }),
  });
}
function managed(value: unknown): ManagedS3Provider {
  const absent = inactive(value);
  if (absent) return absent;
  const row = record(value, ['state', 'client', 'commands', 'backend']);
  const captured = client(row.client);
  if (
    !captured.endpoint ||
    new URL(captured.endpoint).protocol !== 'https:' ||
    !captured.forcePathStyle
  )
    return invalid();
  const commands = record(row.commands, ['instanceId', 'bucket']);
  return Object.freeze({
    state: 'captured',
    client: captured,
    commands: Object.freeze({
      instanceId: instance(commands.instanceId),
      bucket: text(commands.bucket, 255),
    }),
    backend: backend(row.backend),
  });
}
/** Bounds and copies the synchronous owner read; a failed read never exposes input or errors. */
export function observeStorageProviders(read: () => unknown): StorageProviders | undefined {
  try {
    const row = record(read(), ['ordinaryS3', 'managedS3']);
    const value = Object.freeze({
      ordinaryS3: ordinary(row.ordinaryS3),
      managedS3: managed(row.managedS3),
    });
    if (Buffer.byteLength(canonicalManagedJson(value), 'utf8') > MAX_BYTES) return undefined;
    return value;
  } catch {
    return undefined;
  }
}
/** A public immutable copy, never a registration API for caller-supplied client identities. */
export function copyS3ClientCapture(value: S3ClientCapture): S3ClientCapture | undefined {
  try {
    return client(value);
  } catch {
    return undefined;
  }
}
