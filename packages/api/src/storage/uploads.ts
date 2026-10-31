/** Upload storage routing preserves each original's backend; configuration selects only new writes. */
import type { UploadStorageReceipt } from 'librechat-data-provider';
import type { StoragePort } from '../uploads/contract';
import type { NasStoragePort } from './nas';
import { getNasS3StorageCapture } from './nas';

export type UploadStorageComposition = Readonly<{
  storage: StoragePort;
  /** Legacy deletion requires its own genuine provider protocol and retained credentials. */
  managedCleanup: StoragePort;
  /** The actual branded adapter, never the router or an object with a matching kind property. */
  nasCleanup?: NasStoragePort;
}>;

/** No effects at construction. Missing NAS authority fails closed; it never selects another backend. */
export function composeUploadStorage(options: {
  managedStorage: StoragePort;
  /** Its explicit presence selects NAS for future writes, without repointing existing bindings. */
  nasStorage?: NasStoragePort;
}): UploadStorageComposition {
  const managed = options.managedStorage;
  const nas = options.nasStorage;
  if (nas && !getNasS3StorageCapture(nas)) throw new Error('NAS storage authority unavailable');

  function nasOriginal(original: UploadStorageReceipt): NasStoragePort {
    const capture = nas && getNasS3StorageCapture(nas);
    const backend = original.backend;
    if (
      !nas ||
      !capture ||
      !backend ||
      backend.kind !== 'nas-s3' ||
      backend.uid !== capture.backend.uid ||
      backend.configurationSha256 !== capture.backend.configurationSha256 ||
      backend.protocol !== capture.backend.protocol
    )
      throw new Error('NAS original authority unavailable');
    return nas;
  }

  const storage: StoragePort = {
    put(input) {
      if (nas) {
        if (!getNasS3StorageCapture(nas)) throw new Error('NAS storage authority unavailable');
        return nas.put(input);
      }
      return managed.put(input);
    },
    observeOriginal(input) {
      if (input.binding.version === 2) {
        const capture = nas && getNasS3StorageCapture(nas);
        if (
          !nas ||
          !capture ||
          input.binding.backend.uid !== capture.backend.uid ||
          input.binding.backend.configurationSha256 !== capture.backend.configurationSha256 ||
          input.binding.backend.protocol !== capture.backend.protocol ||
          input.binding.bucket !== capture.bucket
        )
          throw new Error('NAS original authority unavailable');
        return nas.observeOriginal(input);
      }
      return managed.observeOriginal(input);
    },
    read(input) {
      return input.original.backend ? nasOriginal(input.original).read(input) : managed.read(input);
    },
    // These methods retain only the legacy protocol. NAS cleanup is explicitly composed above
    // and consumed by its actual repository/File owner, without inventing replica receipts.
    describeDeletion: (input) => managed.describeDeletion(input),
    beginDeletion: (input) => managed.beginDeletion(input),
    observeDeletion: (input) => managed.observeDeletion(input),
    acknowledgeDeletionConsumed: (input) => managed.acknowledgeDeletionConsumed(input),
    remove: (input) => managed.remove(input),
  };
  return Object.freeze({
    storage: Object.freeze(storage),
    managedCleanup: managed,
    ...(nas ? { nasCleanup: nas } : {}),
  });
}
