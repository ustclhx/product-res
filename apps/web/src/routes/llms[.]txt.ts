import { createFileRoute } from '@tanstack/react-router'
import { llmsTxt } from '../features/seo/crawlers.ts'
import { getPublicPages } from '../features/seo/pages.server.ts'
import { getWebRuntime } from '../server/runtime.ts'

export const Route = createFileRoute('/llms.txt')({
  server: {
    handlers: {
      GET: () =>
        new Response(llmsTxt(getPublicPages(), getWebRuntime().config.APP_URL), {
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'public, max-age=300',
          },
        }),
    },
  },
})
