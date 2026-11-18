import { createFileRoute } from '@tanstack/react-router'
import {
  handleMediaCancel,
  handleMediaCancelPreview,
} from '../../../../../features/ai/media-tasks.ts'
import { getAiHttpDeps } from '../../../../../features/ai/runtime.ts'
import { templateConfig } from '../../../../../server/template-config.ts'

function deps() {
  return getAiHttpDeps()
}

export const Route = createFileRoute('/api/ai/tasks/$taskId/cancel')({
  server: {
    handlers: {
      // 只读取消预览：返回本次是否计费与剩余免费次数，供前端确认框使用。
      GET: ({ request, params }) => {
        if (!templateConfig.billing.enabled) return new Response('Not Found', { status: 404 })
        return handleMediaCancelPreview(request, params.taskId, deps())
      },
      POST: ({ request, params }) => {
        if (!templateConfig.billing.enabled) return new Response('Not Found', { status: 404 })
        return handleMediaCancel(request, params.taskId, deps())
      },
    },
  },
})
