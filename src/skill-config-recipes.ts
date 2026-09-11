/**
 * Built-in configuration recipes for well-known skills.
 *
 * A skill should declare its own configuration in `skill.config.json` (see
 * `docs/skill-config.md`); a recipe exists only so a known skill works out of
 * the box for users who installed it from upstream before it shipped a
 * declaration. A skill's own file always wins, so upstream can take over
 * without a plugin release — the same relationship `KNOWN_SKILL_SOURCES` has
 * with install links.
 *
 * Recipes are plugin-owned data, so they are trusted here: they still go
 * through the same validation as an installed declaration, which keeps one
 * grammar and one set of caps for both.
 */

import { EDITABLE_PPT_SKILL } from './skills-catalog.ts'
import { parseSkillConfigManifest, type SkillConfigDeclaration } from './skill-config.ts'

/** One built-in recipe: the raw declaration plus the fields it names. */
interface SkillConfigRecipe {
  name: string
  /** Raw `skill.config.json`-shaped object, validated like any other. */
  declaration: unknown
}

/**
 * The `image-to-editable-ppt` pipeline: it drives `editppt`, which reads
 * `~/.editppt/config.yaml` and needs an OpenAI-compatible image endpoint for
 * page background repair and asset separation. PaddleOCR is optional (the
 * built-in offline detector still works), so its step is guarded.
 */
const RECIPES: readonly SkillConfigRecipe[] = [
  {
    name: EDITABLE_PPT_SKILL,
    declaration: {
      version: 1,
      note: '密钥只写入本机 ~/.editppt/config.yaml；不会进入运行目录、清单或提示词。页面素材需要任何 OpenAI 兼容的图像 API。',
      fields: [
        {
          id: 'image-api-key',
          label: '图像 API 密钥',
          description: '用于页面背景修复与素材分离的 OpenAI 兼容图像 API 密钥',
          type: 'secret',
          required: true,
        },
        {
          id: 'image-base-url',
          label: 'API 地址',
          description: 'OpenAI 兼容的 base URL，例如 https://api.openai.com/v1',
          type: 'string',
          default: 'https://api.openai.com/v1',
          expose: true,
        },
        {
          id: 'image-model',
          label: '图像模型',
          type: 'string',
          default: 'gpt-image-2',
          expose: true,
        },
        {
          id: 'paddle-ocr-token',
          label: 'PaddleOCR token（可选）',
          description: '不填则使用内置离线文字检测；填了文字还原更准（免费额度）',
          type: 'secret',
        },
      ],
      apply: [
        {
          kind: 'command',
          argv: [
            'editppt', 'config',
            '--api-key', '{image-api-key}',
            '--base-url', '{image-base-url}',
            '--model', '{image-model}',
          ],
        },
        {
          kind: 'command',
          argv: ['editppt', 'config', '--paddle-ocr-token', '{paddle-ocr-token}'],
          when: { field: 'paddle-ocr-token', set: true },
        },
      ],
    },
  },
]

/** The built-in declaration for one skill, already validated. */
export function recipeFor(skillName: string): SkillConfigDeclaration | undefined {
  const recipe = RECIPES.find(entry => entry.name === skillName)
  if (recipe === undefined) return undefined
  const parsed = parseSkillConfigManifest(recipe.declaration)
  return parsed.manifest === undefined ? undefined : { manifest: parsed.manifest, source: 'plugin' }
}

/** Skill names this plugin ships a configuration recipe for. */
export function recipeNames(): string[] {
  return RECIPES.map(recipe => recipe.name)
}
