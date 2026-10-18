import type { Database } from '@product-res/db'
import { newId } from '@product-res/shared'
import type { BetterAuthPlugin } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'

/**
 * Better Auth 1.7.7 reserves with a base64 SHA-256 primary key, bypassing generateId.
 * Our verification PK is UUIDv7. Serialize the non-unique, plain identifier instead.
 * Verification is database-authoritative (deletionPlugin); no KV I/O belongs here.
 */
export function verificationReservation(db: Database) {
  const reserve = async (data: { identifier: string; value: string; expiresAt: Date }) =>
    db.$client.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`auth:reservation:${data.identifier}`}, 0))`
      const active =
        await sql`select id from verification where identifier=${data.identifier} and expires_at>clock_timestamp() limit 1`
      if (active.length) return false
      await sql`delete from verification where identifier=${data.identifier} and expires_at<=clock_timestamp()`
      await sql`insert into verification (id,identifier,value,expires_at,created_at,updated_at)
        values (${newId()},${data.identifier},${data.value},${data.expiresAt.toISOString()},now(),now())`
      return true
    })

  return {
    id: 'verification-reservation',
    hooks: {
      before: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            // runPluginInit rebuilds internalAdapter after init. Endpoint hooks run after
            // that rebuild for both auth.handler and auth.api, before proof cleanup.
            ctx.context.internalAdapter.reserveVerificationValue = reserve
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin
}
