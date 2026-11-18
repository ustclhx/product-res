import { env } from 'cloudflare:workers'
import { newId } from '@product-res/shared'
import { describe, expect, it } from 'vitest'
import { createCloudflareStorage } from '../src/cloudflare/index.ts'
import {
  createShareCardImageStore,
  createShareCardInvalidator,
  type ShareCardObjects,
  shareCardImageKey,
  shareCardImagePrefix,
  shareCardRevokedKey,
  shareCardTombstoneKey,
  shareCardWorkspaceKey,
} from '../src/index.ts'

declare module 'cloudflare:workers' {
  namespace Cloudflare {
    interface Env {
      CACHE: KVNamespace
    }
  }
}

const objects = createCloudflareStorage({ FILES: env.FILES }).shareCards as ShareCardObjects

describe('share card invalidation with local R2 and KV', () => {
  it('deletes every version and workspace index and revokes for one day across pages', async () => {
    const identity = { type: 'report', token: `share.${newId()}`, workspaceId: newId() }
    const index = shareCardWorkspaceKey(identity)
    const images = [1, 2, 3].map(
      (v) => `${shareCardImagePrefix(identity.type, identity.token)}${v}-digest.png`,
    )
    for (const key of [...images, index]) await env.FILES.put(key, '')
    const paged = {
      ...objects,
      list: (input: Parameters<ShareCardObjects['list']>[0]) =>
        objects.list({ ...input, limit: 1 }),
    }
    const invalidator = createShareCardInvalidator(paged, env.CACHE)
    await invalidator.invalidateShareCard(identity)
    for (const key of [...images, index]) expect(await env.FILES.head(key)).toBeNull()
    const revoked = shareCardRevokedKey(identity.type, identity.token)
    expect(await env.CACHE.get(revoked)).toBe('1')
    // 强一致的 R2 墓碑与 KV 标记同时写入，永不删除。
    expect(
      await env.FILES.head(shareCardTombstoneKey(identity.type, identity.token)),
    ).not.toBeNull()
    const record = (await env.CACHE.list({ prefix: revoked })).keys[0]
    expect(record?.expiration).toBeGreaterThan(Math.floor(Date.now() / 1000) + 86_390)
    expect(record?.expiration).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 86_401)
    await env.CACHE.delete(revoked)
  })

  it('invalidates every paged workspace index while preserving another workspace', async () => {
    const workspaceId = newId()
    const identities = [1, 2, 3].map(() => ({ type: 'report', token: newId(), workspaceId }))
    const other = { type: 'report', token: newId(), workspaceId: newId() }
    for (const identity of [...identities, other]) {
      await env.FILES.put(shareCardWorkspaceKey(identity), '')
      await env.FILES.put(`${shareCardImagePrefix(identity.type, identity.token)}1-digest.png`, '')
    }
    const malformedIndexes = [
      `share-cards/ws/${workspaceId}/report/..`,
      `share-cards/ws/${workspaceId}/report/invalid/extra`,
    ]
    for (const key of malformedIndexes) await env.FILES.put(key, '')
    const paged = {
      ...objects,
      list: (input: Parameters<ShareCardObjects['list']>[0]) =>
        objects.list({ ...input, limit: 1 }),
    }
    const invalidator = createShareCardInvalidator(paged, env.CACHE)
    expect(await invalidator.cleanupWorkspaceShareCards(workspaceId)).toEqual({
      invalidated: 3,
      complete: true,
    })
    for (const key of malformedIndexes) expect(await env.FILES.head(key)).toBeNull()
    for (const identity of identities) {
      expect(await env.FILES.head(shareCardWorkspaceKey(identity))).toBeNull()
      expect(
        await env.FILES.head(`${shareCardImagePrefix(identity.type, identity.token)}1-digest.png`),
      ).toBeNull()
      expect(await env.CACHE.get(shareCardRevokedKey(identity.type, identity.token))).toBe('1')
      await env.CACHE.delete(shareCardRevokedKey(identity.type, identity.token))
    }
    expect(await env.FILES.head(shareCardWorkspaceKey(other))).not.toBeNull()
    expect(await env.CACHE.get(shareCardRevokedKey(other.type, other.token))).toBeNull()
    await invalidator.invalidateShareCard(other)
    await env.CACHE.delete(shareCardRevokedKey(other.type, other.token))
  })

  it('keeps the workspace retry index and revocation marker after an object deletion fails', async () => {
    const identity = { type: 'report', token: newId(), workspaceId: newId() }
    const index = shareCardWorkspaceKey(identity)
    const image = `${shareCardImagePrefix(identity.type, identity.token)}1-digest.png`
    await env.FILES.put(index, '')
    await env.FILES.put(image, '')
    const invalidator = createShareCardInvalidator(
      {
        ...objects,
        delete: async () => {
          throw new Error('unavailable')
        },
      },
      env.CACHE,
    )
    await expect(invalidator.invalidateShareCard(identity)).rejects.toThrow('unavailable')
    expect(await env.FILES.head(index)).not.toBeNull()
    expect(await env.CACHE.get(shareCardRevokedKey(identity.type, identity.token))).toBe('1')
    await createShareCardInvalidator(objects, env.CACHE).invalidateShareCard(identity)
    await env.CACHE.delete(shareCardRevokedKey(identity.type, identity.token))
  })
})

describe('share card image store with local R2', () => {
  it('stores expiry metadata and the workspace index, then invalidation removes both', async () => {
    const store = createShareCardImageStore(objects)
    const ref = { type: 'report', token: newId(), variant: '1-abcdef12', workspaceId: newId() }
    const expiresAt = new Date(Date.now() + 3_600_000)
    await store.write(ref, new Uint8Array([137, 80, 78, 71]), expiresAt)
    const hit = await store.read(ref)
    expect(hit).toEqual({ status: 'hit', body: new Uint8Array([137, 80, 78, 71]), expiresAt })
    const stored = await env.FILES.head(shareCardImageKey(ref.type, ref.token, ref.variant))
    expect(stored?.httpMetadata?.contentType).toBe('image/png')
    expect(stored?.customMetadata).toEqual({
      'expires-at': expiresAt.toISOString(),
      'workspace-id': ref.workspaceId,
    })
    expect(await env.FILES.head(shareCardWorkspaceKey(ref))).not.toBeNull()
    await createShareCardInvalidator(objects, env.CACHE).invalidateShareCard(ref)
    expect(await store.read(ref)).toEqual({ status: 'miss' })
    expect(await env.FILES.head(shareCardWorkspaceKey(ref))).toBeNull()
    expect(await store.isRevoked(ref.type, ref.token)).toBe(true)
    await env.CACHE.delete(shareCardRevokedKey(ref.type, ref.token))
  })

  it('deletes an expired image on read and keeps never-expiring images', async () => {
    const store = createShareCardImageStore(objects)
    const ref = { type: 'report', token: newId(), variant: '2-ffffffff', workspaceId: newId() }
    expect(await store.isRevoked(ref.type, ref.token)).toBe(false)
    await store.write(ref, new Uint8Array([1]), new Date(Date.now() + 60_000))
    expect(await store.read(ref, new Date(Date.now() + 120_000))).toEqual({ status: 'expired' })
    expect(await env.FILES.head(shareCardImageKey(ref.type, ref.token, ref.variant))).toBeNull()
    await store.write(ref, new Uint8Array([2]), null)
    expect(await store.read(ref, new Date('2100-01-01T00:00:00Z'))).toMatchObject({
      status: 'hit',
      expiresAt: null,
    })
    await store.discard(ref)
    expect(await store.read(ref)).toEqual({ status: 'miss' })
    expect(await env.FILES.head(shareCardWorkspaceKey(ref))).toBeNull()
  })
})
