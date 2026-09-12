/**
 * Bundles the main process and preload with esbuild.
 *
 * Both emit .cjs regardless of package.json "type": "module":
 *  - a sandboxed preload cannot be ESM, so preload.cjs is required
 *  - keeping main.cjs alongside it avoids mixing module systems in one dir
 */
import { build } from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'info',
};

await build({
  ...shared,
  entryPoints: ['electron/main.ts'],
  outfile: 'dist-electron/main.cjs',
});

await build({
  ...shared,
  entryPoints: ['electron/preload.ts'],
  outfile: 'dist-electron/preload.cjs',
});
