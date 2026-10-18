import { AppError } from '@product-res/shared'
import { createFileRoute } from '@tanstack/react-router'
import { apiError } from '../../../features/api-keys/completions.ts'
import { handlePublicMediaSubmit } from '../../../features/api-keys/tasks.ts'
import { getFileMediaHttpDeps } from '../../../features/files/runtime.ts'
import { templateConfig } from '../../../server/template-config.ts'

function deps() {
  return { ...getFileMediaHttpDeps(), config: templateConfig }
}

const unsupported = () =>
  apiError(
    new AppError(
      templateConfig.features.publicApi ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND',
      templateConfig.features.publicApi ? 'Use POST for media tasks' : 'Not found',
      { status: templateConfig.features.publicApi ? 405 : 404 },
    ),
  )

export const Route = createFileRoute('/api/v1/tasks')({
  server: {
    handlers: {
      POST: ({ request }) => {
        if (!templateConfig.billing.enabled) return new Response('Not Found', { status: 404 })
        return handlePublicMediaSubmit(request, deps())
      },
      GET: unsupported,
      HEAD: unsupported,
      PUT: unsupported,
      PATCH: unsupported,
      DELETE: unsupported,
      OPTIONS: unsupported,
    },
  },
})
