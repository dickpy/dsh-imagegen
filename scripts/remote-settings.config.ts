import type { UserConfig } from 'tsdown'
export default {
  entry: { 'settings-scope': '../src/client/settings-scope.ts' },
  outDir: '../.test-build', format: 'esm', platform: 'node', dts: false,
  clean: false, outputOptions: { entryFileNames: '[name].js' },
} satisfies UserConfig
