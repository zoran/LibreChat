/** Fixed Kubernetes exec entry. Native broker owns authentication and exclusion. */
'use strict';

async function main() {
  // This administrative protocol owns stdout. Application log sinks are not part
  // of the command, and must not create persistent files during a finite action.
  process.env.LOG_TO_FILE = 'false';
  try {
    const { runFileCoverageAdmin } = require('@librechat/data-schemas/file-housekeeping-coverage');
    return await runFileCoverageAdmin();
  } catch {
    return 1;
  }
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
module.exports = { main };
