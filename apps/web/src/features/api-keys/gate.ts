import type { TemplateConfig } from '@product-res/config'

export const isPublicApiPath = (path: string) => path === '/api/v1' || path.startsWith('/api/v1/')
export function publicApiNotFound() {
  return Response.json(
    {
      error: {
        code: 'NOT_FOUND',
        message: 'Not found',
        type: 'invalid_request_error',
        param: null,
      },
    },
    { status: 404 },
  )
}
/** 功能关闭时隐藏整个命名空间，包括未知子路径与其他 HTTP 方法。 */
export function gatePublicApiRequest(request: Request, config: TemplateConfig) {
  return !config.features.publicApi && isPublicApiPath(new URL(request.url).pathname)
    ? publicApiNotFound()
    : null
}

/** 路由器的未知页面 404 转成 API 格式；保留业务层已经返回的错误码与头部。 */
export async function normalizePublicApiNotFound(response: Response) {
  if (response.status !== 404) return response
  if (response.headers.get('content-type')?.includes('application/json')) {
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as { error?: { code?: unknown } } | null
    if (typeof body?.error?.code === 'string') return response
  }
  return publicApiNotFound()
}
