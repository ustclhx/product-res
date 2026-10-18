import { existsSync, readFileSync } from 'node:fs'

/**
 * 读取本地连接配置：优先环境变量，其次 Orca worktree 的 .env.worktree（scripts/orca/setup.sh 生成）。
 * 供 drizzle.config.ts 与 vitest.config.ts 使用；都没有时返回 undefined，由调用方决定默认值。
 */
export function readLocalEnv(name: string): string | undefined {
  const fromEnv = process.env[name]
  if (fromEnv) return fromEnv
  const file = new URL('../../.env.worktree', import.meta.url)
  if (!existsSync(file)) return undefined
  const prefix = `${name}=`
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((l) => l.startsWith(prefix))
  return line?.slice(prefix.length).trim() || undefined
}
