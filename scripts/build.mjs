import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['src/content.ts', 'src/popup.ts'],
  outdir: output,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome119',
  legalComments: 'none',
});
for (const asset of ['popup.html', 'icons']) {
  await cp(path.join(root, asset), path.join(output, asset), { recursive: true });
}

// Keep the root install path stable while also emitting a standalone extension.
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
for (const script of manifest.content_scripts) {
  script.js = script.js.map(file => path.posix.relative('dist', file));
}
manifest.action.default_popup = path.posix.relative('dist', manifest.action.default_popup);
await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
