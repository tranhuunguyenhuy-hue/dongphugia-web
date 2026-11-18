import { defineConfig } from 'vite'

// Static Admin shell (M3 G4 pilot). Built into dist/ and served by the Worker static-assets binding under
// /admin-next/ with no Worker invocation for assets. JSX uses the automatic runtime without extra plugins.
export default defineConfig({
  base: '/admin-next/',
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, target: 'es2022' },
  oxc: { jsx: { runtime: 'automatic' } },
})
