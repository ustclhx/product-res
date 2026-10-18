import { createFileRoute } from '@tanstack/react-router'
import { handleFileDownload } from '../../../features/files/http.ts'
import { getWebRuntime } from '../../../server/runtime.ts'

export const Route = createFileRoute('/api/files/$id')({
  server: {
    handlers: {
      GET: ({ request, params }) => {
        return handleFileDownload(request, params.id, getWebRuntime())
      },
    },
  },
})
