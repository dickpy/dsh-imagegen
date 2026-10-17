import { fileURLToPath } from 'node:url'
import configs from '../tsdown.config.ts'
const primitiveCss = fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/Button.module.css', import.meta.url))
export default {
  ...configs[1],
  name: 'template-preview',
  entry: { preview: fileURLToPath(new URL('./template-preview.tsx', import.meta.url)) },
  outDir: fileURLToPath(new URL('../.template-preview', import.meta.url)),
  format: 'iife', sourcemap: false, clean: true,
  deps: { alwaysBundle: ['react', 'react-dom', 'lucide-react'] },
  // Reproduce the host Button atom with its shipped CSS without bundling the
  // entire host UI (markdown/rendering services do not run in this fixture).
  plugins: [...(configs[1].plugins ?? []), {
    name: 'preview-host-button',
    resolveId(id: string) { if (id === '@deepseek-ai/dsh-client-ui-primitives') return '\0preview-button' },
    load(id: string) {
      if (id !== '\0preview-button') return
      return `import { createElement } from 'react'; import css from ${JSON.stringify(primitiveCss)};
        export function Button({variant='ghost',size='md',className,children,...rest}) {
          return createElement('button',{type:'button',...rest,className:[css.button,css[variant],css[size],className].filter(Boolean).join(' ')},children);
        }`
    },
  }],
  outputOptions: { entryFileNames: 'preview.js', banner: '', footer: '', intro: '' },
}
