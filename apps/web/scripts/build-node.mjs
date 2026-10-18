import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
// 在 Turbo 计算 hash 之前确定完整 SHA，避免新提交复用旧版本号的产物。
const version =
  process.env.APP_VERSION ??
  execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
if (!/^[a-f0-9]{40}$/.test(version)) throw new Error('APP_VERSION must be a full git SHA')
const result = spawnSync('pnpm', ['exec', 'turbo', 'run', 'build:node'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, APP_VERSION: version },
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
const maps = spawnSync(process.execPath, ['scripts/sentry-node-maps.mjs'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, APP_VERSION: version },
})
if (maps.error) throw maps.error
process.exit(maps.status ?? 1)
