import { describe, expect, it } from 'vitest'
import { AppError, INTERNAL_ERROR_CODE, isAppError, toErrorResponse } from './errors.ts'

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

  it('hides details of unknown errors', () => {
    const response = toErrorResponse(new Error('connection string postgres://user:pw@host'))
    expect(response.status).toBe(500)
    expect(response.body.error.code).toBe(INTERNAL_ERROR_CODE)
    expect(JSON.stringify(response.body)).not.toContain('postgres://')
  })
})
