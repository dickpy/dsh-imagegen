import { fileURLToPath } from 'node:url'
import configs from '../tsdown.config.ts'
export default {
  ...configs[1], name: 'toolview-preview',
  entry: { preview: fileURLToPath(new URL('./toolview-preview.tsx', import.meta.url)) },
  outDir: fileURLToPath(new URL('../.toolview-preview', import.meta.url)),
  format: 'iife', sourcemap: false, clean: true,
  deps: { alwaysBundle: ['react', 'react-dom'] },
  outputOptions: { entryFileNames: 'preview.js', banner: '', footer: '', intro: '' },
}
