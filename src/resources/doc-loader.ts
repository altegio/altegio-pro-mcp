/**
 * Loader for the markdown documents served as `altegio://docs/*` resources.
 *
 * The documents live in the repository's `docs/` folder and are read at
 * runtime, so a resource never drifts from the document a reviewer edits.
 * Finding that folder has to work in four layouts, and the module's own path is
 * not available in all of them (the test runner transpiles this file to
 * CommonJS, where `import.meta` does not exist), so the candidate roots are
 * derived from the entry script and the working directory instead:
 *
 *  - container   `node dist/http-server.js` with WORKDIR `/app` → `/app/docs`
 *  - stdio host  `node /opt/altegio-pro-mcp/dist/index.js`      → `<pkg>/docs`
 *  - dev / tests run from the repository root                   → `./docs`
 *  - anything else: set `ALTEGIO_DOCS_DIR`.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const REPO_URL = 'https://github.com/altegio/altegio-pro-mcp';

/** Directories to try, most explicit first. */
function candidateRoots(): string[] {
  const roots: string[] = [];

  // Read from the environment rather than the parsed config: this module is
  // also used by tests that never build a full config object.
  const override = process.env.ALTEGIO_DOCS_DIR;
  if (override) {
    roots.push(path.resolve(override));
  }

  const entry = process.argv[1];
  if (entry) {
    const entryDir = path.dirname(path.resolve(entry));
    // dist/index.js → <pkg>/docs; dist/tools/x.js → <pkg>/docs
    roots.push(path.join(entryDir, '..', 'docs'));
    roots.push(path.join(entryDir, '..', '..', 'docs'));
  }

  roots.push(path.join(process.cwd(), 'docs'));
  roots.push(path.join(process.cwd(), '..', 'docs'));

  return roots;
}

function unavailableNote(fileName: string): string {
  return [
    `# Document unavailable`,
    '',
    `\`docs/${fileName}\` is not readable from this deployment.`,
    '',
    `Read it in the repository instead: ${REPO_URL}/blob/main/docs/${encodeURI(fileName)}`,
    '',
    'To serve it here, point `ALTEGIO_DOCS_DIR` at a folder that contains the',
    'markdown documents.',
  ].join('\n');
}

/**
 * Read one document from `docs/`. Never throws: a deployment that ships without
 * the folder returns a short note that says where to read the document
 * instead, which is more useful to a caller than a failed resource read.
 */
export async function readRepoDoc(fileName: string): Promise<string> {
  for (const root of candidateRoots()) {
    try {
      return await readFile(path.join(root, fileName), 'utf8');
    } catch {
      // Try the next candidate.
    }
  }
  return unavailableNote(fileName);
}
