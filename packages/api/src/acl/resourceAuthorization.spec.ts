import { createHash } from 'node:crypto';
import {
  buildManagedRevision,
  managedDigest,
  managedIndexProfileSchema,
  resourceOwnerSchema,
  resourceScopeSchema,
} from 'librechat-data-provider';
import type {
  ResourceAuthorizationRequest,
  ResourceOwner,
  ResourcePrincipal,
  ResourceScope,
  TAccessLevel,
  UploadScope,
} from 'librechat-data-provider';
import type { ResourceAccessReader } from './resourceAuthorization';
import fixture from '../../../data-provider/src/__fixtures__/managed-retrieval-v1.json';
import { authorizeResource, authorizeResourceAudience } from './resourceAuthorization';

const projectId = '0123456789abcdef01234567';
const alice = { tenantId: 'tenant-a', userId: 'alice' };
const bob = { tenantId: 'tenant-a', userId: 'bob' };
const workspace: ResourceOwner = {
  tenantId: alice.tenantId,
  scope: { kind: 'workspace', workspaceId: projectId },
};
const source: ResourceAuthorizationRequest = {
  owner: workspace,
  resourceType: 'file',
  resourceId: 'file-one',
  action: 'read',
};

/** Controlled Identity/ACL adapter only; the helper performs real action/tenant/audience checks. */
function adapter() {
  const memberships = new Map<string, { level: TAccessLevel; revision: number }>([
    ['alice', { level: 'owner', revision: 1 }],
    ['bob', { level: 'editor', revision: 1 }],
  ]);
  const inactive = new Set<string>();
  const reader: ResourceAccessReader = {
    isActive: async (principal) => !inactive.has(principal.userId),
    projectAccess: jest.fn(async (principal, id) =>
      principal.tenantId === 'tenant-a' && id === projectId
        ? (memberships.get(principal.userId) ?? null)
        : null,
    ),
  };
  return { reader, memberships, inactive };
}

it('uses the one scope contract and rejects owner/provenance confusion', () => {
  const upload: UploadScope = workspace.scope;
  const scope: ResourceScope = upload;
  expect(resourceScopeSchema.parse(scope)).toEqual(workspace.scope);
  expect(resourceOwnerSchema.safeParse({ ...workspace, ownerUserId: 'alice' }).success).toBe(false);
  expect(resourceOwnerSchema.safeParse({ ...workspace, tenantId: null }).success).toBe(false);
  expect(resourceOwnerSchema.safeParse({ ...workspace, createdBy: alice }).success).toBe(false);
});

it('admits two current members without substituting the uploader identity', async () => {
  const { reader } = adapter();
  expect(await authorizeResource(alice, source, reader)).toBe(true);
  expect(await authorizeResource(bob, { ...source, action: 'contribute' }, reader)).toBe(true);
  expect(reader.projectAccess).toHaveBeenCalledWith(bob, projectId);
  expect(await authorizeResourceAudience(alice, [source], [alice, bob], reader)).toBe(true);
});

it('enforces existing viewer/editor/owner levels per action', async () => {
  const { reader, memberships } = adapter();
  for (const action of ['remove', 'share', 'administer'] as const)
    expect(await authorizeResource(bob, { ...source, action }, reader)).toBe(false);
  memberships.set('bob', { level: 'viewer', revision: 2 });
  expect(await authorizeResource(bob, source, reader)).toBe(true);
  for (const action of ['upload', 'contribute', 'change'] as const)
    expect(await authorizeResource(bob, { ...source, action }, reader)).toBe(false);
});

it('denies outsider, foreign tenant and foreign project without leaking personal authority', async () => {
  const { reader } = adapter();
  for (const actor of [
    { ...bob, userId: 'outsider' },
    { ...bob, tenantId: 'tenant-b' },
  ])
    expect(await authorizeResource(actor, source, reader)).toBe(false);
  expect(
    await authorizeResource(
      bob,
      {
        ...source,
        owner: { ...workspace, scope: { kind: 'workspace', workspaceId: 'f'.repeat(24) } },
      },
      reader,
    ),
  ).toBe(false);
});

it('denies missing membership adapter and malformed action/resource bindings', async () => {
  const { reader } = adapter();
  expect(
    await authorizeResource(bob, source, { isActive: reader.isActive } as ResourceAccessReader),
  ).toBe(false);
  for (const malformed of [
    { ...source, action: 'root' },
    { ...source, resourceId: null, action: 'remove' },
    { ...source, resourceType: 'chatProject', resourceId: 'foreign' },
  ])
    expect(await authorizeResource(bob, malformed as ResourceAuthorizationRequest, reader)).toBe(
      false,
    );
});

it('preserves personal access and rejects private sources in shared outputs', async () => {
  const { reader } = adapter();
  const personal: ResourceAuthorizationRequest = {
    ...source,
    owner: { tenantId: alice.tenantId, scope: { kind: 'personal' }, ownerUserId: alice.userId },
  };
  expect(await authorizeResource(alice, personal, reader)).toBe(true);
  expect(await authorizeResource(bob, personal, reader)).toBe(false);
  expect(await authorizeResourceAudience(alice, [personal], [alice, bob], reader)).toBe(false);
  expect(
    await authorizeResourceAudience(
      alice,
      [source],
      [alice, { ...bob, tenantId: 'tenant-b' }],
      reader,
    ),
  ).toBe(false);
  expect(await authorizeResourceAudience(alice, [source], [], reader)).toBe(false);
  expect(await authorizeResourceAudience(alice, [source], [bob, bob], reader)).toBe(false);
});

it('re-reads membership and session state before later delivery checks', async () => {
  const { reader, memberships, inactive } = adapter();
  expect(await authorizeResourceAudience(alice, [source], [alice, bob], reader)).toBe(true);
  memberships.delete('bob');
  expect(await authorizeResourceAudience(alice, [source], [alice, bob], reader)).toBe(false);
  memberships.set('bob', { level: 'editor', revision: 3 });
  inactive.add('bob');
  expect(await authorizeResourceAudience(alice, [source], [alice, bob], reader)).toBe(false);
});

it('snapshots recipients and sources before asynchronous authorization', async () => {
  const { reader } = adapter();
  const audience: ResourcePrincipal[] = [alice, { ...bob, userId: 'outsider' }];
  const sources = [{ ...source }];
  const initial = reader.isActive;
  reader.isActive = async (principal) => {
    audience.pop();
    sources[0].resourceId = 'replaced';
    return initial(principal);
  };
  expect(await authorizeResourceAudience(alice, sources, audience, reader)).toBe(false);
});

it('keeps the existing personal retrieval revision/generation stable across membership changes', async () => {
  const { reader, memberships } = adapter();
  const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
  const key = () => ({
    revision: buildManagedRevision(fixture.revisionInput as never, sha256),
    generation: managedDigest(managedIndexProfileSchema.parse(fixture.indexProfile), sha256),
  });
  const before = key();
  expect(await authorizeResource(bob, source, reader)).toBe(true);
  memberships.delete('bob');
  expect(await authorizeResource(bob, source, reader)).toBe(false);
  expect(key()).toEqual(before);
  expect(before.revision).toEqual(fixture.revision);
  expect(before.generation).toBe(fixture.key.indexGeneration);
});
