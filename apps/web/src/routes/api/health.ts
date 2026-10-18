import { createFileRoute } from '@tanstack/react-router'
import { healthResponse } from '../../server/health.ts'
import { getWebRuntime } from '../../server/runtime.ts'

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: () => {
        const runtime = getWebRuntime()
        return healthResponse({
          database: () => runtime.db,
          version: __APP_VERSION__,
          ...(runtime.health && { dependencies: runtime.health }),
        })
      },
    },
  },
})
