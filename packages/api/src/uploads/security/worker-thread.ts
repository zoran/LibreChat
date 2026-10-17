/** Trusted text/CSV thread: no I/O/model. Process/network isolation is the deployment owner. */
import { parentPort, workerData } from 'node:worker_threads';
import { inspectTextSecurity } from './text';

if (parentPort) {
  try {
    const result = inspectTextSecurity(workerData);
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
