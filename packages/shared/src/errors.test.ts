import { describe, expect, it } from 'vitest'
import {
  AppError,
  INTERNAL_ERROR_CODE,
  insufficientCreditsError,
  isAppError,
  parseInsufficientCredits,
  toErrorResponse,
} from './errors.ts'

describe('AppError', () => {
  it('serializes to the API error body', () => {
    const error = new AppError('INSUFFICIENT_CREDITS', 'Not enough credits', { status: 402 })
    expect(isAppError(error)).toBe(true)
    expect(toErrorResponse(error)).toEqual({
      status: 402,
      body: { error: { code: 'INSUFFICIENT_CREDITS', message: 'Not enough credits' } },
    })
  })

  it('defaults to status 400', () => {
    expect(new AppError('BAD_INPUT', 'Bad input').status).toBe(400)
  })

  it('keeps the cause without exposing it', () => {
    const cause = new Error('db password=secret')
    const error = new AppError('UPSTREAM', 'Upstream failed', { cause })
    expect(error.cause).toBe(cause)
    expect(JSON.stringify(error.toJSON())).not.toContain('secret')
  })

  it('公开任意业务的显式 publicDetails，隐藏内部 details', () => {
    const error = new AppError('RATE_LIMITED', 'Try later', {
      status: 429,
      details: { secret: 'private', retryAfter: 99 },
      publicDetails: { retryAfter: 60, scope: 'workspace' },
    })
    expect(error.toJSON()).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Try later',
        details: { retryAfter: 60, scope: 'workspace' },
      },
    })
    expect(toErrorResponse(error).body).toEqual(error.toJSON())
  })

  it('内部 AppError 隐藏 code、message 和所有详情，保留 HTTP 状态', () => {
    const response = toErrorResponse(
      new AppError('DATABASE_FAILED', 'private connection', {
        status: 503,
        details: { secret: 'private' },
        publicDetails: { retryAfter: 60 },
        expose: false,
      }),
    )
    expect(response).toEqual({
      status: 503,
      body: { error: { code: INTERNAL_ERROR_CODE, message: 'Internal error' } },
    })
  })

  it('默认公开的 5xx AppError 保留 code（如缓存不可用的 503）', () => {
    const response = toErrorResponse(
      new AppError('CACHE_UNAVAILABLE', 'Cache is unavailable', {
        status: 503,
        details: { secret: 'private' },
      }),
    )
    expect(response).toEqual({
      status: 503,
      body: { error: { code: 'CACHE_UNAVAILABLE', message: 'Cache is unavailable' } },
    })
  })

  it('hides details of unknown errors', () => {
    const response = toErrorResponse(new Error('connection string postgres://user:pw@host'))
    expect(response.status).toBe(500)
    expect(response.body.error.code).toBe(INTERNAL_ERROR_CODE)
    expect(JSON.stringify(response.body)).not.toContain('postgres://')
  })
})

describe('insufficient credits contract', () => {
  it('只公开余额不足的两个合法整数，隐藏所有其他 details', () => {
    const error = insufficientCreditsError(8, 2)
    if (error.details) error.details.secret = 'private'
    const response = toErrorResponse(error)
    expect(response).toEqual({
      status: 402,
      body: {
        error: {
          code: 'INSUFFICIENT_CREDITS',
          message: 'Insufficient credits',
          details: { estimatedCredits: 8, availableCredits: 2 },
        },
      },
    })
    expect(
      toErrorResponse(
        new AppError('CREDIT_DEBT', 'Debt', {
          details: { estimatedCredits: 8, availableCredits: 2, secret: 'private' },
        }),
      ).body.error,
    ).not.toHaveProperty('details')
    expect(toErrorResponse(insufficientCreditsError(Number.NaN, 2)).body.error).not.toHaveProperty(
      'details',
    )
  })

  it('解析 HTTP、AppError 与 SDK JSON message 并只返回公共字段', () => {
    const error = insufficientCreditsError(8, 2)
    const body = error.toJSON()
    for (const value of [error, body, JSON.stringify(body), new Error(JSON.stringify(body))])
      expect(parseInsufficientCredits(value)).toEqual({ estimatedCredits: 8, availableCredits: 2 })
  })

  it('拒绝其他错误码、不完整或非非负安全整数数值', () => {
    for (const value of [
      null,
      new Error('unavailable'),
      { error: { code: 'CREDIT_DEBT', details: { estimatedCredits: 8, availableCredits: 2 } } },
      ...[undefined, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '2'].map(
        (availableCredits) => ({
          error: {
            code: 'INSUFFICIENT_CREDITS',
            details: { estimatedCredits: 8, availableCredits },
          },
        }),
      ),
    ])
      expect(parseInsufficientCredits(value)).toBeUndefined()
  })
})
