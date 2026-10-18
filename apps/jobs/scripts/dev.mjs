#!/usr/bin/env node
// 本地运行 jobs：wrangler dev，端口与 Hyperdrive 本地连接串取自仓库根目录的 .env.worktree
// （Orca worktree，docs/09-parallel-plan.md §2）；文件不存在时（主 checkout）使用默认值。
// --test-scheduled 暴露 /__scheduled?cron=...，用于手动触发 Cron。额外参数原样传给 wrangler。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { syncLocalPaymentEnv } from '../../../scripts/local-payment-env.mjs'

syncLocalPaymentEnv(new URL('../', import.meta.url))

const file = new URL('../../../.env.worktree', import.meta.url)
const worktreeEnv = existsSync(file)
  ? Object.fromEntries(
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => /^[A-Z0-9_]+=/.test(line))
        .map((line) => [
          line.slice(0, line.indexOf('=')),
          line.slice(line.indexOf('=') + 1).trim(),
        ]),
    )
  : {}

const env = { ...process.env }
for (const binding of ['HYPERDRIVE', 'HYPERDRIVE_CACHED']) {
  const name = `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${binding}`
  if (worktreeEnv[name] && !env[name]) env[name] = worktreeEnv[name]
}

const args = [
  'dev',
  // Workers AI 无本地模拟；本地启动不连接远程绑定。
  '--local',
  '--port',
  worktreeEnv.JOBS_PORT ?? '8788',
  '--inspector-port',
  worktreeEnv.JOBS_INSPECTOR_PORT ?? '9230',
  '--test-scheduled',
  ...process.argv.slice(2),
]
const child = spawn('wrangler', args, { stdio: 'inherit', env })
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
