import { fileURLToPath } from 'node:url'
import configs from '../tsdown.config.ts'
export default {
  ...configs[1], name: 'studio-preview',
  entry: { preview: fileURLToPath(new URL('./studio-preview.tsx', import.meta.url)) },
  outDir: fileURLToPath(new URL('../.studio-preview', import.meta.url)), format: 'iife', sourcemap: false, clean: true,
  deps: { alwaysBundle: ['react', 'react-dom', 'lucide-react'] },
  plugins: [...configs[1].plugins!, { name: 'fixture-host-controls', resolveId(source: string) { return source === '@deepseek-ai/dsh-client-ui-primitives' ? fileURLToPath(new URL('./studio-primitives.tsx', import.meta.url)) : null } }],
  outputOptions: { entryFileNames: 'preview.js', banner: '', footer: '', intro: '' },
}
