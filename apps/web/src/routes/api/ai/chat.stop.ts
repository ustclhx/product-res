import { createFileRoute } from '@tanstack/react-router'
import { handleChatRequestStopRequest } from '../../../features/ai/chat.ts'
import { getWebRuntime } from '../../../server/runtime.ts'
import { templateConfig } from '../../../server/template-config.ts'

export const Route = createFileRoute('/api/ai/chat/stop')({
  server: {
    handlers: {
      POST: ({ request }) => {
        if (!templateConfig.billing.enabled) return new Response('Not Found', { status: 404 })
        const { db, auth } = getWebRuntime()
        return handleChatRequestStopRequest(request, { db, auth })
      },
    },
  },
})
