import { describe, expect, it } from 'vitest'
import { registerSecretValues, safeErrorMessage } from './errors.ts'

describe('错误信息脱敏', () => {
  it('抹去凭据请求头的整个值、JSON 形式与常见密钥形态', () => {
    const cases = [
      'authorization: Bearer sk-abcdefghijklmnop',
      'Authorization=Basic dXNlcjpwYXNz',
      '{"authorization":"Bearer sk-abcdefghijklmnop"}',
      "{'x-api-key': 'anthropic-key-value'}",
      'x-goog-api-key: AIzaSyA1234567890abcdefghij',
      'cf-aig-authorization: Bearer gateway-token',
      'failed with key sk-proj-abcdefghijklmnop',
    ]
    const secrets = [
      'sk-abcdefghijklmnop',
      'dXNlcjpwYXNz',
      'anthropic-key-value',
      'AIzaSy',
      'gateway-token',
      'sk-proj',
    ]
    for (const text of cases) {
      const safe = safeErrorMessage(new Error(text))
      expect(safe, text).toContain('<redacted>')
      for (const secret of secrets) expect(safe, text).not.toContain(secret)
    }
    expect(safeErrorMessage(new Error('see https://host/path?key=1'))).toBe('see <url>')
  })

  it('抹去已登记的出口环境变量字面值', () => {
    registerSecretValues({ DEEPSEEK_API_KEY: 'plain-literal-credential', AI_TEXT_EGRESS: 'direct' })
    const safe = safeErrorMessage(new Error('rejected plain-literal-credential via direct egress'))
    expect(safe).toBe('rejected <redacted> via direct egress')
  })
})
