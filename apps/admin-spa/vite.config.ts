import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/postcss'
import { defineConfig } from 'vite'

// Static Admin SPA (M3). Built into dist/ and served by the Worker static-assets binding under /admin-next/ with no
// Worker invocation for assets. JSX uses the automatic runtime without extra plugins. Tailwind v4 runs through the
// repository PostCSS config; `@` resolves to the shared shadcn-style primitives in src/ (Admin imports only pure
// client components from there: no Next or server-only modules).
export default defineConfig({
  base: '/admin-next/',
  resolve: { alias: { '@': fileURLToPath(new URL('../../src', import.meta.url)) } },
  css: { postcss: { plugins: [tailwindcss()] } },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, target: 'es2022' },
  oxc: { jsx: { runtime: 'automatic' } },
})
