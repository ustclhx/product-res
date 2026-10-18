import { createFileRoute } from '@tanstack/react-router'
import { handleMediaList, handleMediaSubmit } from '../../../features/ai/media-tasks.ts'
import { getAiHttpDeps } from '../../../features/ai/runtime.ts'
import { getFileMediaHttpDeps } from '../../../features/files/runtime.ts'
import { templateConfig } from '../../../server/template-config.ts'

function deps() {
  return getAiHttpDeps()
}

export const Route = createFileRoute('/api/ai/tasks')({
  server: {
    handlers: {
      POST: ({ request }) => {
        if (!templateConfig.billing.enabled) return new Response('Not Found', { status: 404 })
        return handleMediaSubmit(request, getFileMediaHttpDeps())
      },
      GET: ({ request }) => {
        if (!templateConfig.billing.enabled) return new Response('Not Found', { status: 404 })
        return handleMediaList(request, deps())
      },
    },
  },
})
