import { expect, it } from 'vitest'
import { notificationLink } from './notifications.ts'

it('接受站内路径，并保留查询串与正常的路径编码', () => {
  expect(notificationLink('/app/team/tasks/123?tab=result#preview')).toBe(
    '/app/team/tasks/123?tab=result#preview',
  )
  expect(notificationLink('/app/%E4%BB%BB%E5%8A%A1')).toBe('/app/%E4%BB%BB%E5%8A%A1')
  expect(notificationLink(null)).toBeNull()
})

it.each([
  'https://evil.test',
  'javascript:alert(1)',
  '//evil.test',
  '/\\evil.test',
  '%2F%2Fevil.test',
  '/%2Fevil.test',
  '/%252Fevil.test',
  '/%5Cevil.test',
  '/%255Cevil.test',
  '/%09/evil.test',
  '/%0A/evil.test',
  '/\t/evil.test',
])('拒绝开放跳转变体 %s', (link) => {
  expect(() => notificationLink(link)).toThrow(
    expect.objectContaining({ code: 'INVALID_NOTIFICATION_LINK' }),
  )
})
