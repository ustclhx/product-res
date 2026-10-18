import { createFileRoute } from '@tanstack/react-router'
import { submitGrowth } from '../../../features/growth/http.ts'
export const Route = createFileRoute('/api/waitlist/')({
  server: { handlers: { POST: ({ request }) => submitGrowth(request, 'waitlist') } },
})
