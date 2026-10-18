import { describe, expect, it } from 'vitest'
import { EMAIL_QUEUE_MESSAGE_VERSION, parseEmailQueueMessage } from './queue.ts'

const valid = {
  v: EMAIL_QUEUE_MESSAGE_VERSION,
  template: 'reset-password',
  props: { url: 'https://product.ezarouter.cc/reset?token=abc', expiresInMinutes: 60 },
  to: 'user@example.com',
  locale: 'zh-CN',
  appName: 'product-res',
  idempotencyKey: 'key-1',
}

describe('parseEmailQueueMessage', () => {
  it('接受合法消息并保留各字段', () => {
    expect(parseEmailQueueMessage(valid)).toEqual(valid)
    expect(parseEmailQueueMessage({ ...valid, locale: null })?.locale).toBeNull()
  })

  it('旧消息可不带语言，仍可解析并由消费者按默认语言发送', () => {
    const { locale: _locale, ...legacy } = valid
    expect(parseEmailQueueMessage(legacy)).toEqual(legacy)
  })

  it('请求 ID 可选：保留合法值，旧消息不带该键，格式不对时只丢弃该字段', () => {
    const requestId = '01890a5d-ac96-774b-bcce-b302099a8057'
    expect(parseEmailQueueMessage({ ...valid, requestId })).toEqual({ ...valid, requestId })
    expect(parseEmailQueueMessage(valid)).not.toHaveProperty('requestId')
    expect(parseEmailQueueMessage({ ...valid, requestId: 'x'.repeat(65) })).not.toHaveProperty(
      'requestId',
    )
    expect(parseEmailQueueMessage({ ...valid, requestId: 42 })).toEqual(valid)
  })

  it('按模板名校验 props', () => {
    const invitation = {
      ...valid,
      template: 'workspace-invitation',
      props: {
        url: 'https://product.ezarouter.cc/accept-invitation?id=1',
        workspaceName: 'Acme',
        inviterName: 'Alice',
        role: 'owner',
        expiresInDays: 7,
      },
    }
    expect(parseEmailQueueMessage(invitation)).toEqual(invitation)
    // reset-password 的 props 放到 invitation 模板下
    expect(parseEmailQueueMessage({ ...valid, template: 'workspace-invitation' })).toBeNull()
    expect(
      parseEmailQueueMessage({ ...invitation, props: { ...invitation.props, role: 'unknown' } }),
    ).toBeNull()
  })

  it.each([
    ['未知版本', { ...valid, v: 2 }],
    ['未知模板', { ...valid, template: 'debug' }],
    ['收件人不是邮箱', { ...valid, to: 'not-an-email' }],
    ['缺少幂等键', { ...valid, idempotencyKey: undefined }],
    ['链接不是 http(s)', { ...valid, props: { ...valid.props, url: 'javascript:alert(1)' } }],
    ['非对象', 'hello'],
    ['null', null],
  ])('拒绝格式错误的消息：%s', (_, body) => {
    expect(parseEmailQueueMessage(body)).toBeNull()
  })
})
