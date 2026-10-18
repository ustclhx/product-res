import { createFileRoute } from '@tanstack/react-router'
import { getWebRuntime } from '../../../server/runtime.ts'

// Better Auth 的全部接口（basePath /api/auth）
const handle = ({ request }: { request: Request }) => getWebRuntime().handleAuthRequest(request)

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: { GET: handle, POST: handle },
  },
})
