import type { TemplateConfig } from '@product-res/config'
import type { Database } from '@product-res/db'
import { newId } from '@product-res/shared'
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { z } from 'zod'
import { checkSessionInDatabase } from './fresh-session.ts'
import {
  localeSchema,
  profileImageSchema,
  profileNameSchema,
  timezoneSchema,
} from './settings-schema.ts'

/**
 * 用户设置（tasks.md 5.2）在 Better Auth 接口上的服务端规则：
 * - `user.locale` / `user.timezone` 经 `/update-user` 写入，值由字段校验器限定（`userSettingsFields`）；
 * - `/update-user` 的 `name` / `image` 在执行前校验（Better Auth 对这两个字段不做校验）；
 * - 修改密码一律吊销该用户的其他会话（specs/user-auth「普通页面的吊销延迟」），不由客户端决定。
 */

/** `createAuth` 中 `user.additionalFields` 的定义：`null` 表示跟随浏览器 / 模板默认值 */
export function userSettingsFields(config: TemplateConfig) {
  return {
    locale: {
      type: 'string',
      required: false,
      validator: { input: localeSchema(config) },
    },
    timezone: {
      type: 'string',
      required: false,
      validator: { input: timezoneSchema },
    },
  } as const
}

const profileBody = z.looseObject({
  name: profileNameSchema.optional(),
  image: profileImageSchema.optional(),
})

export function accountSettings(db: Database, config: TemplateConfig, clientIp?: string | null) {
  return {
    id: 'account-settings',
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === '/update-user',
          handler: createAuthMiddleware(async (ctx) => {
            const result = profileBody.safeParse(ctx.body)
            if (!result.success) {
              throw APIError.from('BAD_REQUEST', {
                code: 'VALIDATION_ERROR',
                message: result.error.issues[0]?.message ?? 'Invalid profile',
              })
            }
            const token = await ctx.getSignedCookie(
              ctx.context.authCookies.sessionToken.name,
              ctx.context.secret,
            )
            const fresh = token ? await checkSessionInDatabase(db, token) : null
            if (fresh?.ok && fresh.value.session.impersonatedBy) {
              const parsed = profileBody
                .extend({
                  locale: localeSchema(config).optional(),
                  timezone: timezoneSchema.optional(),
                })
                .strict()
                .safeParse(ctx.body)
              if (!parsed.success)
                throw APIError.from('BAD_REQUEST', {
                  code: 'VALIDATION_ERROR',
                  message: parsed.error.issues[0]?.message ?? 'Invalid profile',
                })
              const changes = parsed.data
              const actor = fresh.value
              await db.$client.begin(async (sql) => {
                const [before] =
                  await sql`select name,image,locale,timezone from "user" where id=${actor.user.id} for update`
                const [live] =
                  await sql`select id from session where id=${actor.session.id} and expires_at>now()`
                if (!live)
                  throw APIError.from('UNAUTHORIZED', {
                    code: 'SESSION_REQUIRED',
                    message: 'Session expired',
                  })
                if (Object.keys(changes).length) {
                  await sql`update "user" set ${sql({ ...changes, updated_at: new Date().toISOString() })} where id=${actor.user.id}`
                  await sql`insert into audit_log (id,actor_user_id,action,target_type,target_id,ip,meta)
                    values (${newId()},${actor.user.id},'user.profile_updated','user',${actor.user.id},
                    ${clientIp ?? null},${JSON.stringify({ before, after: changes, impersonatedBy: actor.session.impersonatedBy })}::jsonb)`
                }
              })
              // 清除被模拟用户的会话缓存，下次读取数据库中的新资料。
              await ctx.context.options.secondaryStorage?.delete(actor.session.token)
              const updated = await db.query.user.findFirst({
                where: (u, { eq }) => eq(u.id, actor.user.id),
              })
              if (updated) await setSessionCookie(ctx, { session: actor.session, user: updated })
              return ctx.json({ status: true })
            }
            // 去掉首尾空白后的名字
            if (result.data.name !== undefined) {
              return { context: { body: { ...ctx.body, name: result.data.name } } }
            }
          }),
        },
        {
          matcher: (ctx) => ctx.path === '/change-password',
          // 无论客户端是否传入，都吊销其他会话；当前会话由 Better Auth 换发新会话
          handler: createAuthMiddleware(async (ctx) => ({
            context: { body: { ...ctx.body, revokeOtherSessions: true } },
          })),
        },
      ],
    },
  } satisfies BetterAuthPlugin
}
