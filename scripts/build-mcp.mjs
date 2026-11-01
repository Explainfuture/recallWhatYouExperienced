import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(new URL('../dist-mcp/', import.meta.url), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['mcp/server.mjs'],
  outfile: 'dist-mcp/server.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  legalComments: 'inline',
  logLevel: 'info',
});
await copyFile(new URL('../AGENTS.md', import.meta.url), new URL('../dist-mcp/AGENTS.md', import.meta.url));
