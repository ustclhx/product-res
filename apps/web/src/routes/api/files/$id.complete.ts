import { createFileRoute } from '@tanstack/react-router'
import { handleFileComplete } from '../../../features/files/http.ts'
import { getWebRuntime } from '../../../server/runtime.ts'

export const Route = createFileRoute('/api/files/$id/complete')({
  server: {
    handlers: {
      POST: ({ request, params }) => {
        return handleFileComplete(request, params.id, getWebRuntime())
      },
    },
  },
})
