import { Button } from '@product-res/ui'
import { useLocation } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import {
  baseLocale,
  getLocale,
  isLocale,
  type Locale,
  locales,
  localizeUrl,
} from '../../paraglide/runtime.js'
import { isPrerenderedPath } from '../marketing/prerender.ts'
import { isAppAreaPath } from './app-area.ts'
import { getLanguageSuggestion, saveLanguagePreference } from './preference.functions.ts'
import { rememberLocale } from './preference.ts'

/**
 * 独立组件，预渲染页只在水合后获取 Accept-Language 建议，不改变 URL。
 * 默认固定在左下角；`placement="inline"` 用于后台侧栏等自带位置的容器，避免浮层遮挡内容。
 */
export function LanguageControls({
  placement = 'floating',
}: {
  placement?: 'floating' | 'inline'
} = {}) {
  const floating = placement === 'floating'
  const location = useLocation()
  const [suggestion, setSuggestion] = useState<Locale | null>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const locale = getLocale()
  useEffect(() => {
    setReady(true)
    setSuggestion(null)
    if (
      !(isPrerenderedPath(location.pathname, locales) || location.pathname === '/pricing') ||
      locale !== baseLocale
    )
      return
    let active = true
    void getLanguageSuggestion().then(
      (value) => {
        if (active) setSuggestion(value)
      },
      () => {
        if (active) setError(m.i18n_suggestion_failed())
      },
    )
    return () => {
      active = false
    }
  }, [location.pathname, locale])

  async function select(next: Locale) {
    setBusy(true)
    setError(null)
    try {
      await saveLanguagePreference({ data: next })
      rememberLocale(next)
      // 完整导航让账号语言、SSR 与客户端同时刷新；营销页始终以目的 URL 为准。
      window.location.assign(
        isAppAreaPath(window.location.pathname)
          ? window.location.href
          : localizeUrl(window.location.href, { locale: next }).href,
      )
    } catch {
      setError(m.i18n_save_failed())
      setBusy(false)
    }
  }

  return (
    <>
      {suggestion && (
        <aside
          aria-label={m.i18n_suggestion_label()}
          className="flex flex-wrap items-center justify-center gap-3 border-b bg-muted px-4 py-3"
        >
          <p>
            {m.i18n_suggestion({
              language:
                new Intl.DisplayNames([suggestion], { type: 'language' }).of(suggestion) ??
                suggestion,
            })}
          </p>
          <Button type="button" disabled={busy} onClick={() => void select(suggestion)}>
            {m.i18n_switch()}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              rememberLocale(locale)
              setSuggestion(null)
            }}
          >
            {m.i18n_dismiss()}
          </Button>
        </aside>
      )}
      <label
        className={
          floating
            ? 'fixed bottom-4 left-4 z-50 rounded-md border bg-background px-3 py-2 text-sm shadow-sm'
            : 'inline-flex w-fit rounded-md border bg-background px-3 py-1.5 text-sm shadow-xs'
        }
      >
        <span className="sr-only">{m.i18n_language()}</span>
        <select
          aria-label={m.i18n_language()}
          value={locale}
          disabled={!ready || busy}
          onChange={(event) => {
            if (isLocale(event.target.value)) void select(event.target.value)
          }}
        >
          {locales.map((value) => (
            <option key={value} value={value}>
              {new Intl.DisplayNames([value], { type: 'language' }).of(value) ?? value}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p
          role="alert"
          className={floating ? 'fixed bottom-16 left-4' : 'text-destructive text-sm'}
        >
          {error}
        </p>
      )}
    </>
  )
}
