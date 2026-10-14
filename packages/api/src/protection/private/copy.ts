import type { MessageMethods } from '@librechat/data-schemas';
import type { ShareContentPreflight } from '../../shared-links/protection';
import { getPrivateTextInspectionTokens } from './submission';

type CopyMessage = {
  readonly isCreatedByUser?: boolean;
  readonly messageId?: string;
  readonly text?: string;
  readonly privacyRevision?: string;
  readonly privateTextTokens?: readonly string[];
  readonly user?: unknown;
  readonly __v?: number;
  readonly sourceFileIds?: readonly string[];
  readonly sourceContentRemovedAt?: unknown;
};
const copiedTokens = new WeakMap<object, readonly string[]>();
type NativeSource = { messageId: string; messageVersion: number | null };
const copiedSources = new WeakMap<object, NativeSource>();

/** Only native callers supply server-loaded source rows. External imports use the default. */
export function saveCopiedMessage<T extends object>(
  builder: { saveMessage: (message: T) => CopyMessage },
  source: CopyMessage,
  clone: T,
  nativeCopy = false,
): void {
  const message = builder.saveMessage(clone);
  if (!nativeCopy) {
    return;
  }
  const retained = source.sourceFileIds?.length || source.sourceContentRemovedAt;
  const sameOwner =
    source.user != null && message.user != null && String(source.user) === String(message.user);
  if (retained && !sameOwner)
    throw new Error('Document-dependent history cannot be copied to another owner.');
  const sourceRef =
    copiedSources.get(source) ??
    (sameOwner && source.messageId
      ? { messageId: source.messageId, messageVersion: source.__v ?? null }
      : undefined);
  if (sourceRef) copiedSources.set(message, sourceRef);
  const trusted = copiedTokens.get(source) ?? [...getPrivateTextInspectionTokens([source])];
  const tokens = trusted.filter((token) => message.text?.includes(token));
  if (tokens.length > 0) {
    copiedTokens.set(message, tokens);
  }
}

export function getNativeCopyProvenance(messages: readonly CopyMessage[]): {
  privateTextTokens: ReadonlyMap<string, readonly string[]>;
  nativeSources: ReadonlyMap<string, NativeSource>;
} {
  const tokens = new Map<string, readonly string[]>();
  const nativeSources = new Map<string, NativeSource>();
  for (const message of messages) {
    const trusted = copiedTokens.get(message);
    if (message.messageId && trusted != null) {
      tokens.set(message.messageId, trusted);
    }
    const source = copiedSources.get(message);
    if (message.messageId && source) nativeSources.set(message.messageId, source);
  }
  return { privateTextTokens: tokens, nativeSources };
}

export function getNativeCopyInspectionTokens(
  messages: readonly CopyMessage[],
): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const message of messages) {
    for (const token of copiedTokens.get(message) ?? []) {
      tokens.add(token);
    }
  }
  return tokens;
}

/** No extra metadata or persistence work for ordinary imports. */
export function saveNativeCopyMessages(
  save: MessageMethods['bulkSaveMessages'],
  messages: Parameters<MessageMethods['bulkSaveMessages']>[0],
): Promise<unknown> {
  const provenance = getNativeCopyProvenance(messages);
  return provenance.privateTextTokens.size > 0 || provenance.nativeSources.size > 0
    ? save(messages, true, provenance)
    : save(messages, true);
}

export function transferNativeCopyProvenance<T extends object>(source: object, target: T): T {
  const tokens = copiedTokens.get(source);
  if (tokens != null) {
    copiedTokens.set(target, tokens);
  }
  const sourceRef = copiedSources.get(source);
  if (sourceRef) copiedSources.set(target, sourceRef);
  return target;
}

/** Public snapshots gain only internal provenance from their authorized canonical read. */
export function createNativeCopyPreflight(
  preflight?: ShareContentPreflight,
): ShareContentPreflight {
  return async (snapshot, context) => {
    await preflight?.(snapshot, context);
    const trusted = getPrivateTextInspectionTokens(context?.canonicalMessages ?? []);
    for (const message of snapshot.messages) {
      const tokens: string[] = [];
      if (message.isCreatedByUser === true && typeof message.text === 'string') {
        for (const match of message.text.matchAll(
          /\[(?:EMAIL|PHONE|NAME|CREDENTIAL|CUSTOM)_\d+_[a-f0-9]{32}\]/g,
        )) {
          if (trusted.has(match[0])) {
            tokens.push(match[0]);
          }
        }
      }
      if (tokens.length > 0) {
        copiedTokens.set(message, tokens);
      }
    }
  };
}
