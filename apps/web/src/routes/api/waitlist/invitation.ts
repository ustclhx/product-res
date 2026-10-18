import { createFileRoute } from '@tanstack/react-router'
import { acceptWaitlistLink } from '../../../features/growth/http.ts'
export const Route = createFileRoute('/api/waitlist/invitation')({
  server: { handlers: { GET: ({ request }) => acceptWaitlistLink(request) } },
})
