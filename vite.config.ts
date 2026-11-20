import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset URLs so the build works from any sub-path (GitHub Pages serves it at /myrme/).
  base: './',
  server: { host: '127.0.0.1', strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
