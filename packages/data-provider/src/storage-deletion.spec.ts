import assert from 'node:assert/strict';
import { isStorageDeletionRequest, isStorageDeletionResult } from './storage-deletion';
const request = {
  protocol: 1 as const,
  requestId: 'persisted-request',
  generation: '2',
  authorityBindingSHA256: 'a'.repeat(64),
  acceptedObjectSHA256: 'b'.repeat(64),
};
const binding = {
  ...request,
  bucket: 'private-bucket',
  key: 'managed-uploads/user/op.2__original',
};
describe('opaque storage deletion contract', () => {
  it('requires canonical bounded request fields', () => {
    expect(isStorageDeletionRequest(request)).toBe(true);
    for (const changed of [
      { generation: '02' },
      { generation: '9223372036854775808' },
      { protocol: 2 },
      { requestId: '' },
      { authorityBindingSHA256: 'x' },
      { inventory: [] },
    ])
      assert.equal(isStorageDeletionRequest({ ...request, ...changed }), false);
  });
  it('accepts only exact terminal evidence and never upgrades absence', () => {
    const terminal = {
      ...binding,
      state: 'durable_delete_complete',
      obligationId: 'opaque-id',
      aggregateRevision: '3',
      proofSHA256: 'c'.repeat(64),
    };
    expect(isStorageDeletionResult(terminal, binding)).toBe(true);
    assert.equal(
      isStorageDeletionResult(
        { ...binding, state: ['pending'], obligationId: 'opaque-id' },
        binding,
      ),
      false,
    );
    for (const changed of [
      { key: 'other' },
      { bucket: 'other' },
      { requestId: 'other' },
      { generation: '3' },
      { aggregateRevision: '0' },
      { proofSHA256: '' },
      { replicas: [] },
    ])
      assert.equal(isStorageDeletionResult({ ...terminal, ...changed }, binding), false);
    assert.equal(isStorageDeletionResult(terminal, binding, 'different'), false);
    assert.equal(
      isStorageDeletionResult(
        { ...binding, state: 'namespace_absent', obligationId: 'opaque-id' },
        binding,
      ),
      true,
    );
    assert.equal(isStorageDeletionResult({ ...terminal, state: 'pending' }, binding), false);
    assert.equal(isStorageDeletionResult({ ...binding, state: 'unknown' }, binding), true);
  });
});
