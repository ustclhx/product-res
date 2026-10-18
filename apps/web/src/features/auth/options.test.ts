import { defineTemplateConfig } from '@product-res/config'
import { describe, expect, it } from 'vitest'
import { authUiOptions } from './options.ts'

const app = {
  name: 'Test',
  url: 'https://product.ezarouter.cc',
  supportEmail: 'hxl15380@gmail.com',
}
const credentials = {
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  GITHUB_CLIENT_ID: 'id',
  GITHUB_CLIENT_SECRET: 'secret',
  TURNSTILE_SITE_KEY: 'site-key',
}

describe('authUiOptions（登录页显示哪些入口）', () => {
  it('默认配置：邮箱密码、验证码、Google、GitHub，关闭魔法链接', () => {
    expect(authUiOptions(defineTemplateConfig({ app }), credentials)).toEqual({
      emailPassword: true,
      emailOtp: true,
      magicLink: false,
      oauth: ['google', 'github'],
      turnstileSiteKey: 'site-key',
    })
  })

  it('按模板配置开关各登录方式', () => {
    const config = defineTemplateConfig({
      app,
      auth: { emailPassword: false, emailOtp: false, magicLink: true, oauth: ['github'] },
    })
    expect(authUiOptions(config, credentials)).toMatchObject({
      emailPassword: false,
      emailOtp: false,
      magicLink: true,
      oauth: ['github'],
    })
  })

  it('缺少凭据的 OAuth 提供方不显示（服务端也不会注册它）', () => {
    const { GOOGLE_CLIENT_SECRET: _, ...env } = credentials
    expect(authUiOptions(defineTemplateConfig({ app }), env).oauth).toEqual(['github'])
  })

  it('关闭 Turnstile 时不下发 site key', () => {
    const config = defineTemplateConfig({ app, auth: { turnstile: false } })
    expect(authUiOptions(config, credentials).turnstileSiteKey).toBeNull()
  })
})
