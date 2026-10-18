import { AppError } from '@product-res/shared'
import { createFileRoute } from '@tanstack/react-router'
import { getAiHttpDeps } from '../../../../features/ai/runtime.ts'
import { apiError } from '../../../../features/api-keys/completions.ts'
import { handlePublicMediaDetail } from '../../../../features/api-keys/tasks.ts'
import { templateConfig } from '../../../../server/template-config.ts'

function deps() {
  return { ...getAiHttpDeps(), config: templateConfig }
}

const unsupported = () =>
  apiError(
    new AppError(
      templateConfig.features.publicApi ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND',
      templateConfig.features.publicApi ? 'Use GET for media tasks' : 'Not found',
      { status: templateConfig.features.publicApi ? 405 : 404 },
    ),
  )

export const Route = createFileRoute('/api/v1/tasks/$taskId')({
  server: {
    handlers: {
      GET: ({ request, params }) => {
        if (!templateConfig.billing.enabled) return new Response('Not Found', { status: 404 })
        return handlePublicMediaDetail(request, params.taskId, deps())
      },
      POST: unsupported,
      HEAD: unsupported,
      PUT: unsupported,
      PATCH: unsupported,
      DELETE: unsupported,
      OPTIONS: unsupported,
    },
  },
})
