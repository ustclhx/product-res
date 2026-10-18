import { verifyTurnstile } from '@product-res/auth'
import { normalizeSignupEmail } from '@product-res/billing'
import { AppError } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import { z } from 'zod'
import { getWebRuntime, type WebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import {
  type GrowthContext,
  joinWaitlist,
  requireGrowthFeature,
  subscribeNewsletter,
  updateNewsletterStatus,
} from './service.ts'
import { verifyGrowthToken } from './tokens.ts'

export type GrowthRuntime = Pick<
  WebRuntime,
  'db' | 'emailQueue' | 'rateLimiter' | 'requestMeta'
> & {
  readonly config: Pick<
    WebRuntime['config'],
    'APP_URL' | 'BETTER_AUTH_SECRET' | 'TURNSTILE_SECRET_KEY'
  >
}

export function growthContext(runtime: GrowthRuntime = getWebRuntime()): GrowthContext {
  return {
    db: runtime.db,
    config: templateConfig,
    secret: runtime.config.BETTER_AUTH_SECRET,
    appUrl: runtime.config.APP_URL,
    queue: runtime.emailQueue,
  }
}

export async function growthResponse(action: () => Promise<Response>): Promise<Response> {
  try {
    return await action()
  } catch (error) {
    if (error instanceof AppError)
      return Response.json(
        { error: { code: error.code, message: error.message } },
        {
          status: error.status,
          ...(error.status === 429 ? { headers: { 'Retry-After': '60' } } : {}),
        },
      )
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return Response.json(
        { error: { code: 'INVALID_INPUT', message: 'Enter a valid email address' } },
        { status: 400 },
      )
    log.error('growth.request_failed', { error: error instanceof Error ? error.name : 'unknown' })
    throw error
  }
}

export async function submitGrowth(
  request: Request,
  feature: 'waitlist' | 'newsletter',
  runtime?: GrowthRuntime,
  ctx?: GrowthContext,
) {
  return growthResponse(async () => {
    requireGrowthFeature(ctx?.config ?? templateConfig, feature)
    runtime ??= getWebRuntime()
    ctx ??= growthContext(runtime)
    const ip = runtime.requestMeta.clientIp
    if (!(await runtime.rateLimiter.limit('auth', `${feature}:ip:${ip ?? 'unknown'}`)).success)
      throw new AppError('RATE_LIMITED', 'Try again later', { status: 429 })
    const input = z.object({ email: z.string().trim().pipe(z.email()) }).parse(await request.json())
    const email = normalizeSignupEmail(input.email)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email))
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    if (!(await runtime.rateLimiter.limit('auth', `${feature}:email:${hash}`)).success)
      throw new AppError('RATE_LIMITED', 'Try again later', { status: 429 })
    if (ctx.config.auth.turnstile) {
      const token = request.headers.get('x-turnstile-token')
      if (
        !runtime.config.TURNSTILE_SECRET_KEY ||
        !token ||
        !(await verifyTurnstile(runtime.config.TURNSTILE_SECRET_KEY, token, ip))
      )
        throw new AppError('TURNSTILE_FAILED', 'Human verification failed', { status: 403 })
    }
    if (feature === 'waitlist') await joinWaitlist(ctx, email)
    else await subscribeNewsletter(ctx, email)
    return Response.json({ ok: true })
  })
}

export async function newsletterLink(
  request: Request,
  purpose: 'confirm' | 'unsubscribe',
  ctx?: GrowthContext,
) {
  return growthResponse(async () => {
    requireGrowthFeature(ctx?.config ?? templateConfig, 'newsletter')
    ctx ??= growthContext()
    await updateNewsletterStatus(ctx, new URL(request.url).searchParams.get('token') ?? '', purpose)
    return new Response(
      purpose === 'confirm'
        ? 'Subscription confirmed. You can close this page.'
        : 'You have unsubscribed. You can close this page.',
      { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } },
    )
  })
}

export async function acceptWaitlistLink(
  request: Request,
  runtime?: Pick<GrowthRuntime, 'config'>,
) {
  return growthResponse(async () => {
    requireGrowthFeature(templateConfig, 'waitlist')
    runtime ??= getWebRuntime()
    const token = new URL(request.url).searchParams.get('token') ?? ''
    if (!(await verifyGrowthToken(runtime.config.BETTER_AUTH_SECRET, token, 'waitlist')))
      throw new AppError('INVALID_TOKEN', 'Invalid or expired invitation', { status: 400 })
    // OAuth 回跳也能取到邀请；凭据绑定数据库邮箱，不能用于任意新账号。
    return new Response(null, {
      status: 302,
      headers: {
        location: '/register',
        'cache-control': 'no-store',
        'set-cookie': `waitlist-invitation=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${new URL(runtime.config.APP_URL).protocol === 'https:' ? '; Secure' : ''}`,
      },
    })
  })
}
