# 技能配置（Skill configuration）

无限画布把 `~/.dsh/skills` 下**可被模型调用**的技能列进节点技能菜单。技能本身是纯数据
（`SKILL.md` + 资源），DSH 只负责发现与加载 —— registry / provider 层没有"配置"概念，
`ctx.shellEnv` 那套托管环境也只收 `DSH_*` 前缀的可信变量。所以技能自己的配置（API 密钥、
OCR token、模型名、后端地址…）过去只能靠技能文档手敲命令行或改 dotfile。

本文定义本插件提供的那一层：**技能声明它要什么配置，画布的技能库负责渲染、保存、生效**。
目标有两个：

1. 任何一个技能都能用同一套机制暴露配置，不需要插件为它写代码；
2. 什么都没声明的老技能行为完全不变（仍然走它自己的文档 / Agent 配置）。

## 1. 声明：`skill.config.json`

技能目录（与 `SKILL.md` 同级）可以放一份 JSON 声明：

```
~/.dsh/skills/<name>/SKILL.md
~/.dsh/skills/<name>/skill.config.json     ← 可选
```

```json
{
  "version": 1,
  "note": "密钥只写入本机 ~/.editppt/config.yaml，不会进入 run 目录或提示词。",
  "fields": [
    {
      "id": "image-api-key",
      "label": "图像 API 密钥",
      "description": "任何 OpenAI 兼容的图像 API 密钥",
      "type": "secret",
      "required": true
    },
    {
      "id": "image-base-url",
      "label": "API 地址",
      "type": "string",
      "default": "https://api.openai.com/v1",
      "expose": true
    },
    {
      "id": "image-model",
      "label": "图像模型",
      "type": "select",
      "default": "gpt-image-2",
      "options": [
        { "value": "gpt-image-2", "label": "gpt-image-2" },
        { "value": "doubao-seedream-5-0-pro-260628", "label": "Seedream 5.0 Pro" }
      ]
    },
    {
      "id": "paddle-ocr-token",
      "label": "PaddleOCR token（可选）",
      "type": "secret"
    }
  ],
  "apply": [
    {
      "kind": "command",
      "argv": [
        "editppt", "config",
        "--api-key", "{image-api-key}",
        "--base-url", "{image-base-url}",
        "--model", "{image-model}"
      ]
    },
    {
      "kind": "command",
      "argv": ["editppt", "config", "--paddle-ocr-token", "{paddle-ocr-token}"],
      "when": { "field": "paddle-ocr-token", "set": true }
    }
  ]
}
```

### 字段（`fields[]`）

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | `^[a-z0-9][a-z0-9-]{0,63}$`，在 `apply` 里用 `{id}` 引用 |
| `label` | | 表单标签；缺省用 `id`（作者语言原样展示） |
| `description` | | 一行说明 |
| `type` | | `string` / `secret` / `boolean` / `number` / `select`，缺省 `string` |
| `required` | | 未填时在节点菜单里显示"需要配置"提示 |
| `default` | | 默认值；`secret` 不建议给默认值 |
| `options` | | 仅 `select`：`[{ value, label }]` |
| `expose` | | `true` 时把该字段值以"已配置"上下文块暴露给模型；`secret` 恒为 `false` |

### 生效步骤（`apply[]`）

按顺序执行，两种 kind：

- `{ "kind": "command", "argv": [...], "cwd"?: "skill" }`
  以**数组参数、无 shell** 方式执行；`{field}` 会被替换成保存的值。`cwd: "skill"` 表示在技能
  目录里执行（默认在 run 目录）。执行只在用户点击「保存并应用」时发生，界面会先展示确切 argv。
- `{ "kind": "file", "path": "~/.editppt/config.yaml", "content": "...{field}..." }`
  物化一份配置文件（`~` 展开，禁止 `..` 逃逸，写入前展示内容）。

`when: { "field": "<id>", "set": true }` 让某一步只在对应字段有值时执行（可选跳过）。

### 约束（前向兼容 + 安全）

- `version` 不是 `1` 时整份声明被忽略（界面给出说明），老插件不会误读新格式。
- 未知 kind / 未知字段被忽略，不报错。
- 上限：32 个字段、16 个步骤、单文件内容 8KB。
- 声明来自**已安装的技能**，因此是不可信数据：解析阶段不做任何执行、不写任何文件。

## 2. 声明从哪里来

按优先级取第一个命中的：

1. `<技能目录>/skill.config.json` —— 技能自带（推荐，上游可直接提供）；
2. 插件内置配方（`src/skill-config-recipes.ts`）—— 给已知但没带声明的技能用，
   目前有 `image-to-editable-ppt`（`editppt config`）；
3. 都没有 → 面板只给通用提示（见 §6）。

内置配方让"已知技能开箱可用"，而技能自己的声明永远优先，上游更新带上声明后自动接管。

## 3. 值存在哪

技能配置值存在**插件自己的 settings 命名空间**里，和渠道密钥同一套存储与脱敏：

```
dsh-imagegen:
  skillConfig:        { "<skill>/<field>": "<明文非密钥值>" }
  skillConfigSecrets: { "<skill>/<field>": "<密钥，role('secret') 脱敏>" }
```

- 密钥字段写进 `skillConfigSecrets`（settings 的红acted 视图只回 `set: true/false`，不回值）；
- 非密钥字段写进 `skillConfig`；
- 删除技能不会自动删值（重装后配置还在）；把字段清空即从 dict 里 `unset`；
- 值**不写回技能目录**，所以 `--force` 覆盖安装不会冲掉配置。

## 4. 生效（apply）

「保存并应用」在宿主侧按声明顺序执行步骤，返回逐步结果（`kind` / 详情 / 成功与否 / 输出尾部）：

- `command`：`spawn(argv[0], argv.slice(1), { cwd, shell: false, timeout })`，输出有上限，
  失败信息回显在面板里；
- `file`：原子写入（同目录临时文件 + rename），缺失的父目录会被创建；
- 返回给浏览器的详情与输出里，**已配置的密钥值会被替换成 `•••`**；
- 没有 `apply` 声明的技能只保存值（靠 `expose` 走提示词，或技能自己读配置文件）。

### 环境变量为什么不在这一层

DSH 的托管 shell 环境（`ctx.shellEnv`）只接受 `DSH_*` 前缀的可信键，无法按技能注入
`PADDLE_OCR_TOKEN` / `OPENAI_API_KEY` 这类变量。因此技能若依赖 env，应该在声明里用
`command` 调用自己的 CLI（写配置文件，如 `editppt config`），或提供 `file` 目标。
插件不假装能注入 env —— 声明里也没有 `env` 这个 kind。

## 5. 界面

- **技能库面板**：每条已安装技能若有声明，展开「配置」：字段表单（密钥输入框只显示
  "已设置/未设置"）、必填标记、说明、`select` 下拉、密钥的「清除」按钮，以及
  「保存」/「保存并应用」和逐步结果。
- **节点技能菜单**：声明了必填字段但还没值的技能，显示「需要配置：<字段名>」和「去配置」
  按钮（点开技能库并展开该技能）。提示不等于禁用：技能可能在没有该值时也能跑，真正的
  失败仍由运行时给出可读错误。

## 6. 没声明的技能

技能库给一段通用提示：该技能没有声明配置项，如果它有环境变量 / 配置文件 / 自己的 CLI，
可以让 Agent 按它的 `SKILL.md` 配置，或按技能文档手动配置。插件不猜、不擅自写文件。

## 7. 已知边界

- 只有**目录形态**的技能（`<name>/SKILL.md`）能带 `skill.config.json`；扁平 `<name>.md`
  只能命中内置配方。这是 DSH 的布局约束（扁平技能没有自己的目录）。
- `command` 只支持可执行文件（无 shell）；Windows 上 `.cmd`/`.bat` 包装器需要技能提供
  `.exe` 或 `.py` + 解释器形式的 argv。
- 同名的两个写入者（两个标签页同时保存）以后写为准；保存接口每次返回刷新后的技能库。
