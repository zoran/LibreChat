/** Presentation of validated classifications; labels and hostnames never establish a resource role. */
import type { StatusNode } from 'librechat-data-provider';
import type { useLocalize } from '~/hooks';

type Localize = ReturnType<typeof useLocalize>;
export function resourceKind(node: StatusNode): string {
  const c = node.classification;
  if (c?.kind === 'server') return `${c.role}-server`;
  if (c?.kind === 'kubernetes') return `kubernetes-${c.role}`;
  return node.identity.kind === 'host' ? 'server-unknown' : 'resource';
}
export function roleLabel(node: StatusNode, t: Localize): string {
  const c = node.classification;
  if (c?.kind === 'server') return t(`com_status_role_${c.role}` as never);
  if (c?.kind === 'kubernetes') return t(`com_status_role_${c.role}` as never);
  return node.identity.kind === 'host' ? t('com_status_role_unknown' as never) : '';
}
export function classificationState(node: StatusNode, now: number): 'known' | 'stale' | 'unknown' {
  const c = node.classification;
  if (!c) return 'unknown';
  return c.state === 'stale' || c.evidence.some((e) => now - e.observedAt > e.maxAgeSeconds)
    ? 'stale'
    : 'known';
}
export function nodeDescription(node: StatusNode, t: Localize): string {
  const role = roleLabel(node, t);
  return role ? `${node.label} · ${role}` : node.label;
}
