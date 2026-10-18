import { createFileRoute } from '@tanstack/react-router'
import { handleChatRequest } from '../../../features/ai/chat.ts'
import { getAiHttpDeps } from '../../../features/ai/runtime.ts'
import { templateConfig } from '../../../server/template-config.ts'

export const Route = createFileRoute('/api/ai/chat')({
  server: {
    handlers: {
      POST: ({ request }) => {
        if (!templateConfig.billing.enabled) return new Response('Not Found', { status: 404 })
        return handleChatRequest(request, getAiHttpDeps())
      },
    },
  },
})
