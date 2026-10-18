import { describe, expect, it } from 'vitest'
import { normalizeSignupEmail } from './signup.ts'

describe('signup email identity', () => {
  it('collapses case, Gmail dots, plus tags and Googlemail aliases', () => {
    expect(normalizeSignupEmail(' A.li.Ce+offers@Googlemail.COM ')).toBe('alice@gmail.com')
    expect(normalizeSignupEmail('alice@gmail.com')).toBe('alice@gmail.com')
  })
  it('keeps non-Gmail dots and tags distinct', () => {
    expect(normalizeSignupEmail(' A.Lice+offers@Example.COM ')).toBe('a.lice+offers@example.com')
  })
})
