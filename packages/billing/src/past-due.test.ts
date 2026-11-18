import { expect, it } from 'vitest'
import { nextPastDueSince } from './past-due.ts'

const day = (n: number) => new Date(Date.UTC(2030, 0, n))

it('keeps the first delinquency time while a subscription update arrives during past_due', () => {
  expect(nextPastDueSince(null, 'past_due', day(1))).toEqual(day(1))
  // Stripe 订阅快照没有欠费时间：欠费 2 天后的更新通知不得清空或推后
  expect(nextPastDueSince(day(1), 'past_due', day(3))).toEqual(day(1))
})

it('keeps the first delinquency time across the daily reconciliation snapshot', () => {
  expect(nextPastDueSince(day(1), 'past_due', day(2))).toEqual(day(1))
  expect(nextPastDueSince(day(1), 'paused', day(2))).toEqual(day(1))
})

it('does not move the start forward on repeated payment retry failures', () => {
  let since = nextPastDueSince(null, 'past_due', day(1))
  since = nextPastDueSince(since, 'past_due', day(3))
  since = nextPastDueSince(since, 'past_due', day(5))
  expect(since).toEqual(day(1))
})

it('clears on recovery and records the new time when delinquent again', () => {
  expect(nextPastDueSince(day(1), 'active', day(4))).toBeNull()
  expect(nextPastDueSince(day(1), 'canceled', day(4))).toBeNull()
  expect(nextPastDueSince(null, 'past_due', day(30))).toEqual(day(30))
})
