import { createFileRoute } from '@tanstack/react-router'
import { handleSharedFileDownload } from '../../../../features/files/http.ts'
import { getWebRuntime } from '../../../../server/runtime.ts'

export const Route = createFileRoute('/api/files/shared/$token')({
  server: {
    handlers: {
      GET: ({ params }) => handleSharedFileDownload(params.token, getWebRuntime()),
    },
  },
})
