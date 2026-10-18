import { createFileRoute } from '@tanstack/react-router'
import { handleChatStopRequest } from '../../../features/ai/chat.ts'
import { getWebRuntime } from '../../../server/runtime.ts'
import { templateConfig } from '../../../server/template-config.ts'

export const Route = createFileRoute('/api/ai/chat/$messageId/stop')({
  server: {
    handlers: {
      POST: ({ request, params }) => {
        if (!templateConfig.billing.enabled) return new Response('Not Found', { status: 404 })
        const { db, auth } = getWebRuntime()
        return handleChatStopRequest(request, params.messageId, { db, auth })
      },
    },
  },
})
