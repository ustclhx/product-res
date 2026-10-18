import { expect, it } from 'vitest'
import { parseBillingQueueMessage } from './queue.ts'

const deliveryId = '01890a5d-ac96-774b-bcce-b302099a8057'

it('keeps an optional request ID and still accepts messages enqueued before it existed', () => {
  expect(parseBillingQueueMessage({ v: 1, deliveryId })).toEqual({ v: 1, deliveryId })
  expect(parseBillingQueueMessage({ v: 1, deliveryId, requestId: 'req-1' })).toEqual({
    v: 1,
    deliveryId,
    requestId: 'req-1',
  })
  // A malformed request ID drops correlation only, never the delivery.
  expect(parseBillingQueueMessage({ v: 1, deliveryId, requestId: 'a b' })).toEqual({
    v: 1,
    deliveryId,
  })
  expect(parseBillingQueueMessage({ v: 2, deliveryId })).toBeNull()
})
