import { requireCapability } from '@product-res/platform'
import { createFileRoute } from '@tanstack/react-router'
import { createQueueAuthEmailSender } from '../../../server/auth-email.ts'
import { devOnly } from '../../../server/dev-only.ts'
import { getWebRuntime } from '../../../server/runtime.ts'

// 调试：向 EMAIL_QUEUE 投递一封验证邮件，由 apps/jobs 的消费者渲染并按 EMAIL_TRANSPORT 发送
// （默认 log 通道只打日志）。
export const Route = createFileRoute('/api/dev/email')({
  server: {
    handlers: {
      POST: ({ request }) =>
        devOnly(async () => {
          const queue = requireCapability(getWebRuntime().emailQueue, 'emailQueue')
          const origin = new URL(request.url).origin
          const sendEmail = createQueueAuthEmailSender({
            queue,
            appName: 'Dev',
            appUrl: origin,
          })
          await sendEmail({ type: 'verify-email', to: 'dev@example.com', url: `${origin}/` })
          return Response.json({ queued: { template: 'verify-email', to: 'dev@example.com' } })
        }),
    },
  },
})
