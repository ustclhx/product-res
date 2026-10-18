import { expect, it } from 'vitest'
import { billingErrorMessage } from './errors.ts'

it('redacts provider SDK key diagnostics before persisting bounded errors', () => {
  const error = new Error(
    'Invalid API Key provided: sk_test_fixture123\nBearer privateToken https://provider.test/private?secret=value',
  )
  const message = billingErrorMessage(error)
  expect(message).not.toContain('fixture123')
  expect(message).not.toContain('privateToken')
  expect(message).not.toContain('provider.test')
  expect(message).not.toContain('\n')
  expect(billingErrorMessage(new Error('x'.repeat(900)))).toHaveLength(500)
})
