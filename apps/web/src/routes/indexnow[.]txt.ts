import { createFileRoute } from '@tanstack/react-router'
import { getWebRuntime } from '../server/runtime.ts'

// IndexNow 协议要求密钥可公开访问，提交时用 keyLocation 指向这里（docs/analytics.md）。
export const Route = createFileRoute('/indexnow.txt')({
  server: {
    handlers: {
      GET: () => {
        const key = getWebRuntime().config.INDEXNOW_KEY?.trim()
        if (!key) return new Response('Not Found', { status: 404 })
        return new Response(key, {
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'public, max-age=300',
          },
        })
      },
    },
  },
})
