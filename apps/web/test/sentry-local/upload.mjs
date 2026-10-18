import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { prepareNodeMaps } from '../../../../scripts/sentry-node-maps.mjs'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const release = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const env = { PATH: process.env.PATH, HOME: process.env.HOME }
for (const key of ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT']) env[key] = process.env[key]

try {
  await prepareNodeMaps({
    root,
    release,
    upload: true,
    env,
    run(args, environment) {
      // CLI 正常输出包含组织/项目；只保留步骤结果，上传凭据仅进入该子进程环境。
      execFileSync('pnpm', ['exec', 'sentry-cli', ...args], {
        cwd: root,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      console.log(
        JSON.stringify({
          step: args.slice(0, 2).join(' '),
          dist: args.includes('--dist') ? args[args.indexOf('--dist') + 1] : undefined,
          status: 'passed',
        }),
      )
    },
  })
  console.log(JSON.stringify({ release, uploaded: true }))
} catch (error) {
  const output = String(error.stderr ?? '') + String(error.stdout ?? '')
  console.error(JSON.stringify({ status: 'failed', forbidden: /403/.test(output) }))
  process.exitCode = 1
}
