import { AI_FEEDBACK_REASONS } from '@product-res/db'
import { describe, expect, it } from 'vitest'
import {
  FEEDBACK_REASONS,
  feedbackInputSchema,
  isFeedbackReason,
  normalizeFeedbackComment,
  scrubSecrets,
} from './feedback.ts'
import { parseQuestions } from './follow-ups.server.ts'

// add-subject-chat tasks.md 3.1、3.2：反馈文字去密钥、输入只接受引用、后续问题解析。

describe('feedback comments', () => {
  it('redacts secrets and tokens', () => {
    const text = [
      'key sk-proj-AbCdEf0123456789ghijKLMN',
      'auth Bearer abc.def.ghi-123456',
      'aws AKIAABCDEFGHIJKLMNOP',
      'gh ghp_abcdefghijklmnopqrstuvwxyz0123',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'hex 0123456789abcdef0123456789abcdef',
      'google AIzaSyA1234567890abcdefghijklmnopqrstuv',
      'stripe whsec_abcdefghijklmnopqrstuvwxyz12',
      'slack xoxb-1234567890-abcdefghij',
      'db postgres://admin:hunter2@db.internal:5432/app',
      'cfg password=hunter3 and api_key: abc123def',
    ].join('\n')
    const scrubbed = scrubSecrets(text)
    for (const secret of [
      'sk-proj',
      'Bearer abc',
      'AKIA',
      'ghp_',
      'eyJhbGci',
      '0123456789abcdef0123',
    ])
      expect(scrubbed).not.toContain(secret)
    expect(scrubbed).toContain('postgres://[REDACTED]@db.internal:5432/app')
    expect(scrubSecrets('The answer was too long and missed my question.')).toBe(
      'The answer was too long and missed my question.',
    )
    expect(normalizeFeedbackComment('   ')).toBeNull()
    expect(normalizeFeedbackComment(' ok ')).toBe('ok')
  })

  it('only accepts a message reference, rating and comment', () => {
    const base = { slug: 's', messageId: '0190f5d8-7a3b-7c3d-8e4f-1234567890ab', rating: 'up' }
    expect(feedbackInputSchema.safeParse(base).success).toBe(true)
    expect(feedbackInputSchema.safeParse({ ...base, rating: null }).success).toBe(true)
    expect(feedbackInputSchema.safeParse({ ...base, modelKey: 'x' }).success).toBe(false)
    expect(feedbackInputSchema.safeParse({ ...base, comment: 'x'.repeat(1001) }).success).toBe(
      false,
    )
    // 共享对话同意只接受布尔值
    expect(feedbackInputSchema.safeParse({ ...base, shareConversation: true }).success).toBe(true)
    expect(feedbackInputSchema.safeParse({ ...base, shareConversation: 'yes' }).success).toBe(false)
  })

  it('accepts only the agreed down-vote reasons, matching the database constraint', () => {
    // 浏览器侧的取值集合必须与 db 包（check 约束）一致
    expect([...FEEDBACK_REASONS]).toEqual([...AI_FEEDBACK_REASONS])
    const base = {
      slug: 's',
      messageId: '0190f5d8-7a3b-7c3d-8e4f-1234567890ab',
      rating: 'down',
    }
    for (const reason of FEEDBACK_REASONS)
      expect(feedbackInputSchema.safeParse({ ...base, reason }).success).toBe(true)
    expect(feedbackInputSchema.safeParse({ ...base, reason: null }).success).toBe(true)
    expect(feedbackInputSchema.safeParse({ ...base, reason: 'rude' }).success).toBe(false)
    expect(feedbackInputSchema.safeParse({ ...base, reason: 'too-long' }).success).toBe(false)
    expect(isFeedbackReason('no_source')).toBe(true)
    expect(isFeedbackReason(undefined)).toBe(false)
  })
})

describe('follow-up parsing', () => {
  it('reads a JSON array, falls back to lines, dedupes and caps the count', () => {
    expect(parseQuestions('Sure: ["A?", "B?", "A?", "C?", "D?"]', 3)).toEqual(['A?', 'B?', 'C?'])
    expect(parseQuestions('1. First?\n2) Second?\n- Third?', 2)).toEqual(['First?', 'Second?'])
    expect(parseQuestions('', 3)).toEqual([])
  })
})
