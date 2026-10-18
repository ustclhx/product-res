import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const paymentSecrets = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_WEBHOOK_ID',
]
const optionalSecrets = ['RESEND_API_KEY', 'AI_GATEWAY_TOKEN', 'SENTRY_DSN']
// 缺少时仅文件签名入口返回 503，不阻断认证、营销页和不需要 S3 的清理 Cron。
const storageSecrets = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']

export const secretRequirements = {
  web: {
    required: [
      'BETTER_AUTH_SECRET',
      'TURNSTILE_SECRET_KEY',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'GITHUB_CLIENT_ID',
      'GITHUB_CLIENT_SECRET',
      ...paymentSecrets,
    ],
    optional: [...optionalSecrets, ...storageSecrets],
  },
  jobs: { required: paymentSecrets, optional: optionalSecrets },
}

async function listSecrets(worker) {
  const { stdout } = await execFileAsync(
    'pnpm',
    [
      '--filter',
      `@product-res/${worker}`,
      'exec',
      'wrangler',
      'secret',
      'list',
      '--env',
      'staging',
      '--format',
      'json',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      timeout: 60_000,
    },
  )
  return JSON.parse(stdout)
}

export async function checkSecrets({
  list = listSecrets,
  write = console.log,
  error = console.error,
} = {}) {
  let exitCode = 0
  for (const [worker, requirements] of Object.entries(secretRequirements)) {
    let names
    try {
      const secrets = await list(worker)
      if (!Array.isArray(secrets) || secrets.some((secret) => typeof secret?.name !== 'string')) {
        throw new Error('Invalid secret list')
      }
      names = new Set(secrets.map((secret) => secret.name))
    } catch {
      // Wrangler 的错误可能携带认证或网络信息，只报告固定的失败提示。
      error(`${worker}: secret list failed`)
      exitCode = 1
      continue
    }
    for (const category of ['required', 'optional']) {
      for (const name of requirements[category]) {
        if (names.has(name)) continue
        write(`${worker} ${category}: ${name}`)
        if (category === 'required') exitCode = 1
      }
    }
  }
  return exitCode
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await checkSecrets()
}
