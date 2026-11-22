import { defineConfig } from 'vitest/config';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The timing test runs after the rest, alone, so parallel test files don't inflate its wall-clock budget.
const timingTests = ['tests/performance.test.ts'];

export default defineConfig({
  plugins: [viteSingleFile()],
  test: {
    projects: [
      { extends: true, test: { name: 'unit', environment: 'jsdom', exclude: [...timingTests, '**/node_modules/**'] } },
      { extends: true, test: { name: 'timing', environment: 'node', include: timingTests, sequence: { groupOrder: 1 } } },
    ],
  },
});
