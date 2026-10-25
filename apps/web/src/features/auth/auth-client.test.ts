import { describe, expect, it } from 'vitest'
import { redirectSearch, signInDestination } from './auth-client.ts'

describe('登录回跳白名单', () => {
  const token = 'A_b-'.repeat(10).concat('xyz')
  it('允许邀请链接，拒绝其它路径与畸形 token', () => {
    expect(signInDestination(`?redirect=${encodeURIComponent(`/join/${token}`)}`)).toBe(
      `/join/${token}`,
    )
    expect(signInDestination('?redirect=/join/short')).toBe('/app')
    expect(signInDestination(`?redirect=${encodeURIComponent(`/join/${token}/x`)}`)).toBe('/app')
    expect(signInDestination('?redirect=https://evil.example/join')).toBe('/app')
  })
  it('登录与注册页之间保留允许的回跳', () => {
    expect(redirectSearch(`?redirect=${encodeURIComponent(`/join/${token}`)}`)).toBe(
      `?redirect=${encodeURIComponent(`/join/${token}`)}`,
    )
    expect(redirectSearch('?redirect=/evil')).toBe('')
  })
})
