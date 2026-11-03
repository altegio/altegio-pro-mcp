import { realpathSync } from 'node:fs';
import { getCallSites } from 'node:util';
import { fileURLToPath } from 'node:url';

/**
 * Compare the actual caller module with Node's entry script, resolving npm bin
 * symlinks too. Native call sites work in both ESM and Jest's CJS transform;
 * checking argv for a runner name or a filename alone does not identify a module.
 */
export function isEntrypoint(): boolean {
  const caller = getCallSites(2, { sourceMap: false })[1]?.scriptName;
  if (!caller || !process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(caller.startsWith('file:') ? fileURLToPath(caller) : caller)
    );
  } catch {
    return false;
  }
}

export function installShutdownSignals(
  shutdown: () => Promise<void>
): () => void {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void shutdown().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return () => {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  };
}
