import { createFileRoute } from '@tanstack/react-router'
import { handleFileUpload } from '../../../features/files/http.ts'
import { getWebRuntime } from '../../../server/runtime.ts'

export const Route = createFileRoute('/api/files/uploads')({
  server: {
    handlers: {
      POST: ({ request }) => {
        return handleFileUpload(request, getWebRuntime())
      },
    },
  },
})
