import { AppError, toErrorResponse } from '@product-res/shared'
import { describe, expect, it } from 'vitest'
import { CreditsError, type CreditsErrorCode } from '../src/index.ts'

describe('CreditsError HTTP contract', () => {
  it('内部积分错误保留身份并返回脱敏的 500', () => {
    const codes: CreditsErrorCode[] = [
      'INVALID_CREDIT_AMOUNT',
      'SOURCE_ALREADY_GRANTED',
      'WORKSPACE_RESOURCE_NOT_FOUND',
      'HOLD_NOT_ACTIVE',
      'INVALID_OVERAGE_POLICY',
    ]
    for (const code of codes) {
      const error = new CreditsError(code)
      expect(error).toBeInstanceOf(AppError)
      expect(error).toBeInstanceOf(CreditsError)
      expect(error.code).toBe(code)
      expect(toErrorResponse(error)).toEqual({
        status: 500,
        body: { error: { code: 'INTERNAL_ERROR', message: 'Internal error' } },
      })
    }
  })

  it('余额不足与欠费即使没有详情也保持 402', () => {
    for (const code of ['INSUFFICIENT_CREDITS', 'CREDIT_DEBT'] as const) {
      expect(toErrorResponse(new CreditsError(code))).toEqual({
        status: 402,
        body: { error: { code, message: code } },
      })
    }
  })

  it('余额不足数值经过校验后才公开', () => {
    expect(
      toErrorResponse(
        new CreditsError('INSUFFICIENT_CREDITS', {
          estimatedCredits: 8,
          availableCredits: 2,
        }),
      ).body.error.details,
    ).toEqual({ estimatedCredits: 8, availableCredits: 2 })
    expect(
      toErrorResponse(
        new CreditsError('INSUFFICIENT_CREDITS', {
          estimatedCredits: 8,
          availableCredits: -1,
        }),
      ).body.error,
    ).not.toHaveProperty('details')
  })
})
