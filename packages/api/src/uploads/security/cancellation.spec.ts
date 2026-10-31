/** Current dispatch retirement stays strict while retained cleanup may join its authentic old protocol. */
import type { UploadSecurityPort } from '../contract';
import { cancelHistoricalSecurityExecution, cancelSecurityExecution } from './cancellation';
import { nasFixture } from '../../files/nasCleanup.fixture';

const historical = {
  version: 2 as const,
  custody: { kind: 'none' as const },
  attemptId: 'retained.1',
  instanceId: '11111111-1111-4111-8111-111111111111',
  executionId: '22222222-2222-4222-8222-222222222222',
  expiresAt: '2026-10-17T02:01:00.000Z',
};
const retired = { execution: historical, writerStopped: true, transientDataRemoved: true };
const signal = new AbortController().signal;
function port(value: unknown) {
  return {
    policySha256: 'a'.repeat(64),
    prepare: jest.fn(),
    inspect: jest.fn(),
    cancel: jest.fn().mockResolvedValue(value),
  } satisfies UploadSecurityPort;
}

it('consumes a matching retained retirement only through the explicit historical cleanup function', async () => {
  const security = port(retired);
  await expect(cancelHistoricalSecurityExecution(security, historical, signal)).resolves.toEqual(
    retired,
  );
  await expect(cancelSecurityExecution(security, historical, signal)).resolves.toBeNull();
  expect(security.prepare).not.toHaveBeenCalled();
  expect(security.inspect).not.toHaveBeenCalled();
});

it.each(['writer-live', 'data-retained', 'wrong-original', 'lost-ack'])(
  'retains historical cleanup for %s without inventing a current AV receipt',
  async (variant) => {
    const receipt = {
      ...retired,
      ...(variant === 'writer-live' ? { writerStopped: false } : {}),
      ...(variant === 'data-retained' ? { transientDataRemoved: false } : {}),
      ...(variant === 'wrong-original'
        ? { execution: { ...historical, executionId: '33333333-3333-4333-8333-333333333333' } }
        : {}),
    };
    const security = port(receipt);
    if (variant === 'lost-ack') security.cancel.mockRejectedValue(new Error('original unknown'));
    await expect(
      cancelHistoricalSecurityExecution(security, historical, signal),
    ).resolves.toBeNull();
    expect(security.cancel).toHaveBeenCalledTimes(1);
  },
);

it('requires complete AV retirement even through historical cleanup when the bound original is current', async () => {
  const fixture = nasFixture();
  const execution = fixture.row().securityExecution!;
  const receipt = fixture.row().securitySettlement!;
  const security = port(receipt);
  await expect(cancelHistoricalSecurityExecution(security, execution, signal)).resolves.toEqual(
    receipt,
  );
  const { antivirusReceipt: _removed, ...missing } = receipt;
  security.cancel.mockResolvedValue(missing);
  await expect(cancelHistoricalSecurityExecution(security, execution, signal)).resolves.toBeNull();
  expect(fixture.transport.calls()).toHaveLength(0);
});
