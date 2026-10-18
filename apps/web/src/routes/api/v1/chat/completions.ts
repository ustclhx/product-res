import { AppError } from '@product-res/shared'
import { createFileRoute } from '@tanstack/react-router'
import { getAiHttpDeps } from '../../../../features/ai/runtime.ts'
import { apiError, handleCompletions } from '../../../../features/api-keys/completions.ts'
import { templateConfig } from '../../../../server/template-config.ts'

const unsupported = () =>
  apiError(
    new AppError(
      templateConfig.features.publicApi ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND',
      templateConfig.features.publicApi ? 'Use POST for chat completions' : 'Not found',
      { status: templateConfig.features.publicApi ? 405 : 404 },
    ),
  )

export const Route = createFileRoute('/api/v1/chat/completions')({
  server: {
    handlers: {
      GET: unsupported,
      HEAD: unsupported,
      PUT: unsupported,
      PATCH: unsupported,
      DELETE: unsupported,
      OPTIONS: unsupported,
      POST: ({ request }) => {
        if (!templateConfig.billing.enabled) return new Response('Not Found', { status: 404 })
        return handleCompletions(request, { ...getAiHttpDeps(), config: templateConfig })
      },
    },
  },
})
