import { defineTemplateConfig } from '@product-res/config'
import { describe, expect, it } from 'vitest'
import {
  gatePublicApiRequest,
  isPublicApiPath,
  normalizePublicApiNotFound,
  publicApiNotFound,
} from './gate.ts'

describe('公开 API 命名空间开关', () => {
  it('关闭时所有方法、未知子路由均返回 OpenAI 兼容 404', async () => {
    const config = defineTemplateConfig({
      app: { name: 'Test', url: 'https://example.test', supportEmail: 'support@example.test' },
      features: { publicApi: false },
    })
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
      for (const path of ['/api/v1', '/api/v1/chat/completions', '/api/v1/missing']) {
        const response = gatePublicApiRequest(
          new Request(`https://example.test${path}`, { method }),
          config,
        )
        expect(response?.status).toBe(404)
        expect(await response?.json()).toMatchObject({
          error: { code: 'NOT_FOUND', type: 'invalid_request_error' },
        })
      }
    }
  })
  it('开启时放行以继续 Bearer 鉴权，未知路由的 404 保持兼容；其他路径不受影响', async () => {
    expect(
      gatePublicApiRequest(
        new Request('https://example.test/api/v1/chat/completions'),
        defineTemplateConfig({
          app: { name: 'Test', url: 'https://example.test', supportEmail: 'support@example.test' },
          features: { publicApi: true },
        }),
      ),
    ).toBeNull()
    for (const path of ['/api/v10', '/api/auth/sign-in/email', '/app/example']) {
      expect(isPublicApiPath(path)).toBe(false)
      expect(
        gatePublicApiRequest(
          new Request(`https://example.test${path}`),
          defineTemplateConfig({
            app: {
              name: 'Test',
              url: 'https://example.test',
              supportEmail: 'support@example.test',
            },
          }),
        ),
      ).toBeNull()
    }
    expect(await publicApiNotFound().json()).toHaveProperty('error.code', 'NOT_FOUND')
  })
  it('只转换路由器的 404，不覆盖模型不可用等已兼容的业务错误', async () => {
    const business = Response.json(
      { error: { code: 'MODEL_UNAVAILABLE', message: 'Model is not available' } },
      { status: 404, headers: { 'x-request-id': 'request' } },
    )
    expect(await normalizePublicApiNotFound(business)).toBe(business)
    const unknown = await normalizePublicApiNotFound(new Response('Missing page', { status: 404 }))
    expect(await unknown.json()).toHaveProperty('error.code', 'NOT_FOUND')
  })
})
