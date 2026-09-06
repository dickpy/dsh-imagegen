import { homedir } from 'node:os'
import path from 'node:path'

const DEFAULT_ROOT = path.join(process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh'), 'dsh-imagegen')
let root = DEFAULT_ROOT

export function imageDataRoot(): string { return root }

export function setImageDataRoot(value: string | undefined): void {
  const trimmed = value?.trim()
  root = trimmed === undefined || trimmed === '' ? DEFAULT_ROOT : path.resolve(trimmed)
}
