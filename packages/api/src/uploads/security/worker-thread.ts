/** Trusted thread entry: no I/O, parser or model. Process/network isolation is the deployment owner. */
import { parentPort, workerData } from 'node:worker_threads';
import { inspectPlainTextSecurity } from './text';

if (parentPort) {
  try {
    const result = inspectPlainTextSecurity(workerData);
    if (workerData.bytes instanceof Uint8Array) workerData.bytes.fill(0);
    workerData.bytes = undefined;
    parentPort.postMessage(JSON.stringify(result));
  } catch {
    parentPort.postMessage(
      JSON.stringify({ decision: 'uninspectable', reason: 'invalid_content' }),
    );
  } finally {
    if (workerData?.bytes instanceof Uint8Array) workerData.bytes.fill(0);
    parentPort.close();
  }
}
