import { createFileRoute } from '@tanstack/react-router'
import { newsletterLink } from '../../../features/growth/http.ts'

const handle = ({ request }: { request: Request }) => newsletterLink(request, 'confirm')
export const Route = createFileRoute('/api/newsletter/confirm')({
  server: { handlers: { GET: handle } },
})
