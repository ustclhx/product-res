import { TURNSTILE_TOKEN_HEADER as SERVER_HEADER } from '@product-res/auth'
import { afterEach, describe, expect, it } from 'vitest'
import { baseLocale, locales, overwriteGetLocale } from '../../paraglide/runtime.js'
import { AUTH_ERROR_MESSAGES, authErrorMessage } from './errors.ts'
import { TURNSTILE_TOKEN_HEADER } from './turnstile.tsx'

describe('authErrorMessage（按错误码提示）', () => {
  afterEach(() => overwriteGetLocale(() => baseLocale))

  it('按调用时的语言显示认证错误，未知错误仍显示本地化通用提示', () => {
    const locale = locales.find((locale) => String(locale) === 'zh') ?? baseLocale
    overwriteGetLocale(() => locale)
    expect(authErrorMessage('INVALID_EMAIL_OR_PASSWORD')).toBe(
      String(locale) === 'zh' ? '邮箱或密码不正确。' : 'Incorrect email or password.',
    )
    expect(authErrorMessage('UNRECOGNIZED')).toBe(
      String(locale) === 'zh' ? '操作失败，请重试。' : 'Something went wrong. Please try again.',
    )
  })

  it('429 一律提示限流', () => {
    expect(authErrorMessage({ status: 429 })).toBe(AUTH_ERROR_MESSAGES.RATE_LIMITED)
    expect(authErrorMessage({ status: 429, code: 'RATE_LIMITED' })).toBe(
      AUTH_ERROR_MESSAGES.RATE_LIMITED,
    )
  })

  it('403 EMAIL_NOT_VERIFIED 提示去邮箱验证（已自动重发）', () => {
    expect(authErrorMessage({ status: 403, code: 'EMAIL_NOT_VERIFIED' })).toBe(
      AUTH_ERROR_MESSAGES.EMAIL_NOT_VERIFIED,
    )
  })

  it('Turnstile 失败与凭据错误', () => {
    expect(authErrorMessage({ status: 403, code: 'TURNSTILE_FAILED' })).toBe(
      AUTH_ERROR_MESSAGES.TURNSTILE_FAILED,
    )
    expect(authErrorMessage({ status: 401, code: 'INVALID_EMAIL_OR_PASSWORD' })).toBe(
      AUTH_ERROR_MESSAGES.INVALID_EMAIL_OR_PASSWORD,
    )
  })

  it('回调 URL 中的错误码（字符串、小写）也能识别', () => {
    expect(authErrorMessage('INVALID_TOKEN')).toBe(AUTH_ERROR_MESSAGES.INVALID_TOKEN)
    expect(authErrorMessage('access_denied')).toBe(AUTH_ERROR_MESSAGES.ACCESS_DENIED)
  })

  it('未知错误给通用提示，不回显服务端原文；未启用的接口（404）提示不可用', () => {
    expect(authErrorMessage({ status: 500, code: 'SOMETHING' })).toBe(AUTH_ERROR_MESSAGES.UNKNOWN)
    expect(authErrorMessage(null)).toBe(AUTH_ERROR_MESSAGES.UNKNOWN)
    expect(authErrorMessage({ status: 404 })).toBe(AUTH_ERROR_MESSAGES.NOT_FOUND)
  })
})

describe('Turnstile 请求头', () => {
  it('与 @product-res/auth 校验的请求头一致', () => {
    expect(TURNSTILE_TOKEN_HEADER).toBe(SERVER_HEADER)
  })
})
