import { defineConfig } from 'vite';

// Static SPA build. Relative base so the bundle works no matter what
// sub-path nginx / QNAP serves it from.
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
});
