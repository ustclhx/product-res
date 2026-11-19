import { type ChildProcess, spawn } from 'node:child_process'
import { loadEnv } from 'vite'

// 启动 `stripe listen` 把测试模式回调转发到本地 web，等待 Ready 后再开始测试；结束时只停止自己启动的进程。
// 需要已登录的 Stripe CLI（stripe login），且根目录 .env.local 的 STRIPE_WEBHOOK_SECRET 与
// `stripe listen --print-secret` 一致（本地回调用该 secret 验签）。
// 与 normalizeStripeEvent 支持的快照事件一致（docs/runbooks/p2-payment-integration.md §3）
const STRIPE_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
]

export default async function globalSetup() {
  const env = loadEnv('worktree', new URL('../../../', import.meta.url).pathname, '')
  const port = Number(env.WEB_PORT ?? 3000)
  const child: ChildProcess = spawn(
    'stripe',
    [
      'listen',
      // 账号默认 API 版本（2026-08-26.dahlia）与代码锁定的 2026-09-30.endive 不同，默认格式的事件会被拒收；
      // CLI 1.53 的 --latest 即 endive。升级 CLI 后若最新版本前移，需同步核对。
      '--latest',
      '--events',
      STRIPE_EVENTS.join(','),
      '--forward-to',
      `http://localhost:${port}/api/billing/webhooks/stripe`,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      // 未 stripe login 时以应用同一测试账号的密钥监听（经环境变量传入，不出现在进程参数中）
      env: {
        ...process.env,
        ...(!process.env.STRIPE_API_KEY && process.env.STRIPE_SECRET_KEY
          ? { STRIPE_API_KEY: process.env.STRIPE_SECRET_KEY }
          : {}),
      },
    },
  )
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stripe listen did not become ready')), 60_000)
    const onData = (chunk: Buffer) => {
      if (chunk.toString().includes('Ready!')) {
        clearTimeout(timer)
        resolve()
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', (code) => reject(new Error(`stripe listen exited with ${code}`)))
  })
  return () => {
    child.kill('SIGTERM')
  }
}
