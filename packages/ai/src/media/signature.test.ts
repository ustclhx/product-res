import { expect, it } from 'vitest'
import { mediaCallbackUrl, verifyMediaCallbackSignature } from './signature.ts'

it('binds media callback signatures to the task and secret', async () => {
  const task = { id: '019bb460-a610-7000-8000-000000000001', provider: 'fal' }
  const url = new URL(await mediaCallbackUrl('https://example.test', 'fixture-secret', task))
  const signature = url.searchParams.get('sig') ?? ''
  expect(url.pathname).toBe('/api/webhooks/media/fal')
  expect(url.searchParams.get('task')).toBe(task.id)
  expect(await verifyMediaCallbackSignature('fixture-secret', task.id, signature)).toBe(true)
  expect(await verifyMediaCallbackSignature('fixture-secret', 'other-task', signature)).toBe(false)
  expect(await verifyMediaCallbackSignature('wrong-secret', task.id, signature)).toBe(false)
  expect(await verifyMediaCallbackSignature('fixture-secret', task.id, 'bad')).toBe(false)
})
