import { defineConfig } from 'vitest/config';

// unit：只用假传输层和假时钟，毫秒级、确定性；integration：启动真实的 im-server（需要 Go）。
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/**/*.test.ts'], exclude: ['test/integration/**'] } },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
