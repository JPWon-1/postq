import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()],
  // Next keeps JSX for its compiler; component rendering tests need the JSX transform here.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts'], // e2e/(Playwright)는 vitest 대상이 아니다
  },
})
