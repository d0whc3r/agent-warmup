import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';

// ink lazy-loads react-devtools-core only under DEV=true; the warmup never does, so
// alias it to an empty stub instead of bundling the real (uninstalled) dependency.
const reactDevtoolsStub = fileURLToPath(new URL('./sea/stub-react-devtools.js', import.meta.url));

// Bundle the whole CLI (and every npm dependency) into ONE ESM file embedded as the
// SEA main (sea-config.json sets "mainFormat": "module"). Only node: builtins stay
// external — provided by the runtime. inlineDynamicImports folds the lazy import()
// chunks back in so a single file can be the SEA entry point.
export default defineConfig({
  entry: { 'claude-warmup': 'src/cli.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node26',
  outDir: 'dist',
  noExternal: [/.*/],
  alias: { 'react-devtools-core': reactDevtoolsStub },
  // The Ink UI (src/ui/App.jsx) is authored in JSX; compile it with React's
  // automatic runtime so files don't need to import React themselves.
  inputOptions: { transform: { jsx: 'react-jsx' } },
  outputOptions: { inlineDynamicImports: true },
  dts: false,
  clean: true,
  shims: false,
});
