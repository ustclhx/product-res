import { Button, Select, SelectContent, SelectItem, SelectTrigger } from '@product-res/ui'
import { useLocation } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import {
  baseLocale,
  getLocale,
  isLocale,
  type Locale,
  locales,
  localizeHref,
  localizeUrl,
} from '../../paraglide/runtime.js'
import { isPrerenderedPath } from '../marketing/prerender.ts'
import { isAppAreaPath } from './app-area.ts'
import { saveLanguagePreference } from './preference.functions.ts'
import { rememberLocale } from './preference.ts'
import {
  detachPrehydrationListener,
  handledBeforeHydration,
  SUGGESTABLE_LOCALES,
  SUGGESTION_ATTRIBUTE,
  suggestionCss,
  suggestionTargets,
} from './suggestion.ts'

/**
 * 独立组件，语言建议只提示、不改变 URL。建议在首帧前由 <head> 脚本决定（suggestion.ts）：
 * 这里在服务端就输出每个候选语言的横幅（默认隐藏），水合后不再插入或移除，避免整页下移的版面跳动。
 * 默认固定在左下角（仅 md 及以上；手机端改由页脚设置行 SiteSettings 渲染）；
 * `placement="inline"` 用于后台侧栏等自带位置的容器，避免浮层遮挡内容。
 * `suggest={false}`：同页已有另一实例负责语言建议时关闭，避免重复横幅。
 * `suggestableLocales`：只建议这些语言，默认取 SUGGESTABLE_LOCALES（与首帧脚本相同），所有实例自动一致。
 * 横幅在水合后的 effect 中带上 data-hydrated（仅属性，无样式与版面变化），供测试判断水合完成。
 */
export function LanguageControls({
  placement = 'floating',
  suggest = true,
  suggestableLocales = SUGGESTABLE_LOCALES,
}: {
  placement?: 'floating' | 'inline' | 'bare'
  suggest?: boolean
  suggestableLocales?: readonly string[] | undefined
} = {}) {
  const floating = placement === 'floating'
  const location = useLocation()
  const [dismissed, setDismissed] = useState(false)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const locale = getLocale()
  const options = locales.map((value) => ({
    value,
    label: new Intl.DisplayNames([value], { type: 'language' }).of(value) ?? value,
  }))
  const currentLocale = options.find((option) => option.value === locale)
  useEffect(() => {
    setReady(true)
    // 水合完成：横幅的点击改由 React 处理，摘除首帧脚本注册的水合前监听
    detachPrehydrationListener()
  }, [])
  // 只在默认语言的营销页（预渲染页与定价页）建议；服务端与水合首次渲染一致，显示与否只由首帧前脚本写入的属性决定
  const suggestions =
    suggest &&
    !dismissed &&
    locale === baseLocale &&
    (isPrerenderedPath(location.pathname, locales) || location.pathname === '/pricing')
      ? suggestionTargets({ baseLocale, locales, suggestableLocales })
      : []

  function dismiss() {
    rememberLocale(locale)
    // 去掉首帧脚本写入的属性：之后客户端导航回到营销页也不再显示
    document.documentElement.removeAttribute(SUGGESTION_ATTRIBUTE)
    setDismissed(true)
  }

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
      {suggestions.length > 0 && <style>{suggestionCss(suggestions)}</style>}
      {suggestions.map((suggestion) => (
        <aside
          key={suggestion}
          data-locale-suggestion-for={suggestion}
          data-hydrated={ready ? '' : undefined}
          aria-label={m.i18n_suggestion_label()}
          className="hidden flex-wrap items-center justify-center gap-3 border-b bg-muted px-4 py-3"
        >
          {/* 横幅文案属于界面提示而非页面内容：data-nosnippet 让搜索引擎不把它用作摘要
              （Google 仅认 div/span/section 上的该属性；display: contents 保持外层 flex 布局） */}
          <div data-nosnippet="" className="contents">
            <p>
              {m.i18n_suggestion({
                language:
                  new Intl.DisplayNames([suggestion], { type: 'language' }).of(suggestion) ??
                  suggestion,
              })}
            </p>
            {/* 真实链接：水合前与关闭 JS 时也能切换（水合前的 Cookie 由首帧脚本写入）；水合后保存账号语言再导航 */}
            <Button asChild aria-disabled={busy || undefined}>
              <a
                href={localizeHref(location.pathname, { locale: suggestion })}
                data-locale-suggestion-action="switch"
                onClick={(event) => {
                  if (handledBeforeHydration(event.nativeEvent)) return
                  event.preventDefault()
                  if (!busy) void select(suggestion)
                }}
              >
                {m.i18n_switch()}
              </a>
            </Button>
            <Button
              type="button"
              variant="ghost"
              data-locale-suggestion-action="dismiss"
              onClick={(event) => {
                if (handledBeforeHydration(event.nativeEvent)) setDismissed(true)
                else dismiss()
              }}
            >
              {m.i18n_dismiss()}
            </Button>
          </div>
        </aside>
      ))}
      <div
        className={
          floating
            ? 'fixed bottom-4 left-4 z-(--z-sticky) rounded-md max-md:hidden bg-background px-3 py-2 text-sm shadow-sm print:hidden'
            : placement === 'bare'
              ? 'inline-flex w-fit text-sm'
              : 'inline-flex w-fit rounded-md bg-background px-3 py-1.5 text-sm shadow-xs'
        }
      >
        <span className="sr-only">{m.i18n_language()}</span>
        <Select
          value={currentLocale ? locale : ''}
          disabled={!ready || busy}
          onValueChange={(value) => {
            if (isLocale(value)) void select(value)
          }}
        >
          <SelectTrigger
            aria-label={m.i18n_language()}
            className="w-full min-w-0"
            placeholder={m.i18n_language()}
            valueLabel={currentLocale?.label}
          />
          <SelectContent>
            {options.map((option, index) => (
              <SelectItem key={option.value} index={index} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {error && (
        <p
          role="alert"
          className={
            floating
              ? 'fixed bottom-16 left-4 z-(--z-sticky) max-md:hidden'
              : 'text-destructive text-sm'
          }
        >
          {error}
        </p>
      )}
    </>
  )
}
