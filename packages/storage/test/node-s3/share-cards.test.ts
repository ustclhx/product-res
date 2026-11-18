import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNodeStorage } from '../../src/node/index.ts'
import { createShareCardImageStore, createShareCardInvalidator } from '../../src/share-cards.ts'
import { type S3Fixture, startS3Fixture } from './fixture.ts'

let fixture: S3Fixture

beforeAll(async () => {
  fixture = await startS3Fixture()
})
afterAll(async () => {
  await fixture?.close()
})

describe('self-host share card images on real S3', () => {
  it('keeps expiry metadata through S3 lower-cased metadata keys and invalidates by prefix', async () => {
    const objects = createNodeStorage(fixture.config).shareCards
    if (!objects) throw new Error('Node storage must provide share card objects')
    const store = createShareCardImageStore(objects)
    const ref = {
      type: 'report',
      token: 'AbCdEfGhIjKlMnOpQrStUv',
      variant: '1-abcdef12',
      workspaceId: '019a03ac-9283-73a8-bca7-4dfbf04e6680',
    }
    const expiresAt = new Date(Date.now() + 3_600_000)
    expect(await store.read(ref)).toEqual({ status: 'miss' })
    await store.write(ref, new Uint8Array([137, 80, 78, 71]), expiresAt)
    expect(await store.read(ref)).toEqual({
      status: 'hit',
      body: new Uint8Array([137, 80, 78, 71]),
      expiresAt,
    })
    expect(await store.read(ref, new Date(expiresAt.getTime() + 1000))).toEqual({
      status: 'expired',
    })
    expect(await store.read(ref)).toEqual({ status: 'miss' })
    await store.write(ref, new Uint8Array([1]), null)
    const marks = new Map<string, string>()
    await createShareCardInvalidator(objects, {
      put: async (key, value) => {
        marks.set(key, value)
      },
    }).invalidateShareCard(ref)
    expect(await store.read(ref)).toEqual({ status: 'miss' })
    // 只留下永不删除的撤销墓碑。
    expect((await objects.list({ prefix: 'share-cards/' })).keys).toEqual([
      `share-cards/revoked/${ref.type}/${ref.token}`,
    ])
    expect(await store.isRevoked(ref.type, ref.token)).toBe(true)
    expect(marks.size).toBe(1)
  })
})
