import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

export const paymentKeys = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_WEBHOOK_ID',
]
const marker = '# BEGIN managed local payment env'
const managedBlock =
  /^# BEGIN managed local payment env\n[\s\S]*?# END managed local payment env\n?/gm

// Wrangler/Vite read app-local .dev.vars, not the repository's .env.local.
// Keep existing auth configuration and append only the five payment bindings.
// Called only by local dev entry points; never embed credentials in build config.
export function syncLocalPaymentEnv(
  appDirectory,
  localFile = new URL('../.env.local', import.meta.url),
) {
  const target = new URL('.dev.vars', appDirectory)
  const original = existsSync(target) ? readFileSync(target, 'utf8') : ''
  const unmanaged = original.replace(managedBlock, '')
  let next = unmanaged
  const hasLocalFile = existsSync(localFile)
  if (hasLocalFile || paymentKeys.some((key) => process.env[key] !== undefined)) {
    const local = hasLocalFile ? parseEnv(readFileSync(localFile, 'utf8')) : {}
    const bindings = paymentKeys.map((key) => {
      const value = process.env[key] ?? local[key] ?? ''
      return `${key}=${JSON.stringify(value)}`
    })
    next = `${unmanaged}${unmanaged && !unmanaged.endsWith('\n') ? '\n' : ''}${marker}\n${bindings.join('\n')}\n# END managed local payment env\n`
  }
  if (next !== original) {
    writeFileSync(target, next, { mode: 0o600 })
    chmodSync(target, 0o600)
  }
}
