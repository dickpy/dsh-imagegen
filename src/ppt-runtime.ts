/** Installs the upstream CLI unchanged in an isolated Python environment. */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { PYTHON_UTF8_ENV, runCommand } from './skill-config.ts'
import type { PptRuntimeStatus } from './protocol.ts'

export class PptRuntime {
  private installing?: Promise<PptRuntimeStatus>
  constructor(private readonly root: () => string, private readonly skillDir: () => Promise<string | undefined>) {}

  private executable(): string {
    return path.join(this.root(), 'ppt-runtime', process.platform === 'win32' ? 'Scripts/editppt.exe' : 'bin/editppt')
  }

  async command(): Promise<string> {
    const local = this.executable()
    return await fs.stat(local).then(s => s.isFile(), () => false) ? local : 'editppt'
  }

  async check(): Promise<PptRuntimeStatus> {
    const command = await this.command()
    const result = await runCommand([command, 'doctor'], { cwd: process.cwd(), timeoutMs: 30_000, env: PYTHON_UTF8_ENV })
    return { available: result.code === 0, message: result.output.slice(0, 12_000) }
  }

  async install(): Promise<PptRuntimeStatus> {
    if (this.installing !== undefined) return this.installing
    this.installing = this.installUpstream().finally(() => { this.installing = undefined })
    return this.installing
  }

  private async installUpstream(): Promise<PptRuntimeStatus> {
    const dir = await this.skillDir()
    if (dir === undefined) throw new Error('请先安装 image-to-editable-ppt skill')
    const cli = path.join(dir, 'cli')
    await fs.access(path.join(cli, 'pyproject.toml'))
    const candidates = process.platform === 'win32' ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']]
    let python: string[] | undefined
    for (const candidate of candidates) {
      const result = await runCommand([...candidate, '-c', 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'], { cwd: dir, timeoutMs: 10_000, env: PYTHON_UTF8_ENV })
      if (result.code === 0) { python = candidate; break }
    }
    if (python === undefined) throw new Error('需要 Python 3.10 或以上版本。安装 Python 后重启 DSH，再点击安装运行环境。')
    const environment = path.join(this.root(), 'ppt-runtime')
    await fs.mkdir(this.root(), { recursive: true })
    const created = await runCommand([...python, '-m', 'venv', environment], { cwd: dir, timeoutMs: 60_000, env: PYTHON_UTF8_ENV })
    if (created.code !== 0) throw new Error(`无法创建 Python 环境：${created.output.slice(-3000)}`)
    const executable = path.join(environment, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    const installed = await runCommand([executable, '-m', 'pip', 'install', '--editable', cli], { cwd: dir, timeoutMs: 180_000, env: PYTHON_UTF8_ENV })
    if (installed.code !== 0) throw new Error(`上游 editppt 安装失败：${installed.output.slice(-3000)}`)
    const setup = await runCommand([this.executable(), 'setup'], { cwd: dir, timeoutMs: 30_000, env: PYTHON_UTF8_ENV })
    if (setup.code !== 0) throw new Error(`editppt setup 失败：${setup.output.slice(-3000)}`)
    return this.check()
  }
}
