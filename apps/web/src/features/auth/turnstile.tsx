import { useCallback, useEffect, useRef, useState } from 'react'
import { m } from '../../paraglide/messages.js'

/**
 * Cloudflare Turnstile 小组件（explicit rendering）。认证入口的请求在请求头 `x-turnstile-token` 中带上令牌，
 * 由 @product-res/auth 的 protection.ts 校验（docs/04-auth-and-tenancy.md §1「防刷」）。
 * 令牌只能用一次：每次请求后调用 `reset()` 换新令牌。本地开发用官方测试 site key（始终通过）。
 */

/** 与 @product-res/auth 的 TURNSTILE_TOKEN_HEADER 一致（有单元测试对照）；不在浏览器代码中引入 @product-res/auth */
export const TURNSTILE_TOKEN_HEADER = 'x-turnstile-token'

export const TURNSTILE_SCRIPT_URL =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

interface TurnstileRenderOptions {
  sitekey: string
  action?: string
  callback: (token: string) => void
  'expired-callback': () => void
  'error-callback': () => void
}

interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string | undefined
  reset(widgetId: string): void
  remove(widgetId: string): void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

let scriptPromise: Promise<TurnstileApi> | undefined

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  scriptPromise ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = TURNSTILE_SCRIPT_URL
    script.async = true
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile unavailable'))
    script.onerror = () => {
      scriptPromise = undefined
      reject(new Error('failed to load turnstile'))
    }
    document.head.appendChild(script)
  })
  return scriptPromise
}

export interface TurnstileState {
  /** 是否启用（site key 非空） */
  readonly enabled: boolean
  /** 当前可用的令牌；未启用时恒为 `null` */
  readonly token: string | null
  /** 未启用，或已拿到令牌 */
  readonly ready: boolean
  /** 请求头：启用且有令牌时带 `x-turnstile-token` */
  headers(): Record<string, string>
  /** 用掉令牌后换新 */
  reset(): void
  /** 放进表单里的小组件容器；未启用时为 `null` */
  readonly widget: React.ReactNode
}

export function useTurnstile(siteKey: string | null, action?: string): TurnstileState {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | undefined>(undefined)
  const [token, setToken] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!siteKey) return
    let cancelled = false
    loadTurnstile()
      .then((api) => {
        if (cancelled || !containerRef.current) return
        widgetIdRef.current = api.render(containerRef.current, {
          sitekey: siteKey,
          ...(action !== undefined && { action }),
          callback: (value) => {
            setFailed(false)
            setToken(value)
          },
          'expired-callback': () => setToken(null),
          'error-callback': () => {
            setToken(null)
            setFailed(true)
          },
        })
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
      const id = widgetIdRef.current
      widgetIdRef.current = undefined
      if (id !== undefined) window.turnstile?.remove(id)
    }
  }, [siteKey, action])

  const reset = useCallback(() => {
    setToken(null)
    const id = widgetIdRef.current
    if (id !== undefined) window.turnstile?.reset(id)
  }, [])

  const headers = useCallback(
    (): Record<string, string> => (token ? { [TURNSTILE_TOKEN_HEADER]: token } : {}),
    [token],
  )

  const enabled = siteKey !== null
  return {
    enabled,
    token: enabled ? token : null,
    ready: !enabled || token !== null,
    headers,
    reset,
    widget: enabled ? (
      <div className="grid min-h-[65px] gap-1">
        <div ref={containerRef} data-testid="turnstile" />
        {failed ? (
          <p className="text-destructive text-sm">
            {m.auth_human_verification_could_not_load_refresh_the_page()}{' '}
          </p>
        ) : null}
      </div>
    ) : null,
  }
}
