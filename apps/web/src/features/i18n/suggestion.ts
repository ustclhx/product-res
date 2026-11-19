// 首次访问的语言建议横幅（specs/i18n「语言选择与记忆」）。
//
// 横幅在页面顶部、位于正文之前：若水合后才插入，整页会被向下推（实测手机端 97px，Lighthouse CLS 0.118）。
// 因此建议在首帧前决定：<head> 内的同步脚本按浏览器语言偏好（navigator.languages，即 Accept-Language 的来源）
// 给 <html> 写入 data-locale-suggestion；页面在 SSR / 预渲染时就输出每个候选语言的横幅（默认隐藏），
// 由 suggestionCss 生成的规则只显示与该属性相符的一条。横幅首帧即在最终位置，水合前后 DOM 不变，没有版面位移。
// 横幅首帧可见、而营销页在首帧后才水合：水合前的点击由同一脚本注册的委托监听处理（渐进增强），
// 「切换语言」本身是指向目标语言地址的链接，没有 JS 也能切换。水合后组件摘除监听，点击交给 React。
// 只依赖本文件的常量，不引用 Paraglide 运行时，便于在根路由的 head 中生成脚本。

/**
 * 首次访问时可建议的语言：undefined 为全部非默认语言。衍生项目只需建议部分语言时在此限定（如 ['zh-Hant']）；
 * 根路由把同一个值传给首帧脚本与横幅，保证脚本选中的语言总有对应横幅，e2e 也据此选择测试语言。
 */
export const SUGGESTABLE_LOCALES: readonly string[] | undefined = undefined

/** <html> 上的属性：值为建议切换到的语言；没有建议时不存在 */
export const SUGGESTION_ATTRIBUTE = 'data-locale-suggestion'
/** 每条候选横幅上的属性（LanguageControls 输出）：值为该横幅建议的语言 */
export const SUGGESTION_TARGET_ATTRIBUTE = 'data-locale-suggestion-for'
/** 横幅按钮上的属性：switch（切换链接）或 dismiss（保留当前语言） */
export const SUGGESTION_ACTION_ATTRIBUTE = 'data-locale-suggestion-action'
/** window 上摘除水合前监听的函数名 */
export const PREHYDRATION_DETACH_KEY = '__saasLocaleSuggestionDetach'
/** 水合前监听已处理的原生点击事件上的标记：React 若重放同一事件，据此跳过，避免重复处理 */
export const PREHYDRATION_HANDLED_KEY = '__saasLocaleSuggestionHandled'

/** 水合前监听是否已处理过这次点击（React 事件处理函数中传入 event.nativeEvent） */
export function handledBeforeHydration(event: Event): boolean {
  return Boolean((event as unknown as Record<string, unknown>)[PREHYDRATION_HANDLED_KEY])
}

/** 水合后由组件调用：摘除首帧脚本注册的点击监听，之后点击只由 React 处理 */
export function detachPrehydrationListener(): void {
  const detach = (window as unknown as Record<string, unknown>)[PREHYDRATION_DETACH_KEY]
  if (typeof detach === 'function') detach()
}

/**
 * 首帧前执行的内联脚本（与 themeInitScript 一样放在 <head>，不依赖打包产物）。
 * 建议条件（与此前水合后按 Accept-Language 询问服务端时相同）：本页是默认语言（<html lang>）、
 * 没有手动选择记录（偏好 Cookie）、浏览器偏好中最先匹配到的配置语言属于可建议语言（suggestionTargets）。
 * 匹配规则见 scriptKey：完整标签（不区分大小写）→ 语言+书写系统 → 主语言子标签。读取失败（如禁用 Cookie）时不建议。
 * 最先匹配到的语言是默认语言或不在可建议范围内时停止，不再看后面的浏览器偏好：该语言是使用者最想要的，
 * 改为建议排在后面的语言会违背其偏好顺序（如偏好 zh-TW、zh-CN 而只允许建议 zh-Hans 时，不应劝繁体用户改看简体）。
 * 有建议时注册捕获阶段的委托点击监听（水合前生效）：「切换」写入目标语言的 Cookie 后由链接自行导航，
 * 「保留当前语言」写入当前语言的 Cookie 并去掉 <html> 属性（横幅随之隐藏）。Cookie 与 rememberLocale 相同；
 * 水合前无法调用 saveLanguagePreference，已登录账号的语言不在此同步（目标页按 URL 显示语言，不受影响）。
 */
export function localeSuggestionScript({
  baseLocale,
  locales,
  preferenceCookie,
  localeCookie,
  cookieMaxAge,
  suggestableLocales,
}: {
  baseLocale: string
  locales: readonly string[]
  /** 可建议的语言，省略时为全部非默认语言；须与 LanguageControls 的同名参数一致 */
  suggestableLocales?: readonly string[] | undefined
  preferenceCookie: string
  /** Paraglide 的语言 Cookie；与 rememberLocale 一样，选择或关闭时两个 Cookie 一起写 */
  localeCookie: string
  cookieMaxAge: number
}): string {
  const json = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c')
  // 键为小写标签，值为配置中的写法（pt-BR 等地区语言按不区分大小写匹配）
  const byTag = Object.fromEntries(locales.map((locale) => [locale.toLowerCase(), locale]))
  // 键为补全后的「语言-书写系统」（小写），值为配置语言；多个配置语言补全相同时取先配置的一个
  const byScript: Record<string, string> = {}
  for (const locale of locales) {
    const key = scriptKey(locale)
    if (key && !(key in byScript)) byScript[key] = locale
  }
  const targets = suggestionTargets({ baseLocale, locales, suggestableLocales })
  // k 与 scriptKey 相同：浏览器不支持 Intl.Locale 或标签无效时返回空串，跳过这一步
  return `(function(){try{var d=document.documentElement,b=${json(baseLocale)},M=${json(byTag)},S=${json(byScript)},C=${json(targets)},n=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||''];if(d.lang!==b||('; '+document.cookie).indexOf(${json(`; ${preferenceCookie}=`)})>=0)return;for(var i=0;i<n.length;i++){var t=String(n[i]).toLowerCase(),l=g(M,t)||g(S,k(t))||g(M,t.split('-')[0]);if(l){if(C.indexOf(l)>=0){d.setAttribute(${json(SUGGESTION_ATTRIBUTE)},l);listen()}return}}}catch(e){}function g(o,x){return o.hasOwnProperty(x)?o[x]:''}function k(x){try{var y=new Intl.Locale(x).maximize();return y.script?(y.language+'-'+y.script).toLowerCase():''}catch(e){return''}}function listen(){var w=window,A=${json(SUGGESTION_ACTION_ATTRIBUTE)};function h(e){var t=e.target&&e.target.closest&&e.target.closest('['+A+']'),f=t&&t.closest('['+${json(SUGGESTION_TARGET_ATTRIBUTE)}+']');if(!f||e[${json(PREHYDRATION_HANDLED_KEY)}])return;e[${json(PREHYDRATION_HANDLED_KEY)}]=1;var s=t.getAttribute(A)==='switch',v=s?f.getAttribute(${json(SUGGESTION_TARGET_ATTRIBUTE)}):d.lang,c='='+v+'; Path=/; Max-Age='+${json(cookieMaxAge)}+'; SameSite=Lax'+(location.protocol==='https:'?'; Secure':'');document.cookie=${json(localeCookie)}+c;document.cookie=${json(preferenceCookie)}+c;if(s){var u=t.getAttribute('href');if(u&&!/[?#]/.test(u))t.setAttribute('href',u+location.search+location.hash)}else d.removeAttribute(${json(SUGGESTION_ATTRIBUTE)})}w.addEventListener('click',h,true);w[${json(PREHYDRATION_DETACH_KEY)}]=function(){w.removeEventListener('click',h,true)}}})()`
}

/**
 * 书写系统匹配键：补全标签（likely subtags）后的「语言-书写系统」，小写。
 * 使配置 zh-Hant / zh-Hans 时无需额外配置即可匹配 zh-TW、zh-HK → zh-Hant，zh-CN、zh-SG、zh → zh-Hans；
 * 只配置 zh 时 zh-TW（zh-Hant）补全不到 zh（zh-Hans），仍由主语言子标签兜底，结果与此前相同。
 * 无法解析时返回空串。首帧脚本中的 k() 是同一逻辑的浏览器端实现。
 */
export function scriptKey(tag: string): string {
  try {
    const locale = new Intl.Locale(tag).maximize()
    return locale.script ? `${locale.language}-${locale.script}`.toLowerCase() : ''
  } catch {
    return ''
  }
}

/**
 * 可建议的语言（首帧脚本与 LanguageControls 共用）：非默认语言，且在 suggestableLocales 中（省略时不限）。
 * 结果按配置顺序，忽略不在 locales 中的值。
 */
export function suggestionTargets<L extends string>({
  baseLocale,
  locales,
  suggestableLocales,
}: {
  baseLocale: string
  locales: readonly L[]
  suggestableLocales?: readonly string[] | undefined
}): L[] {
  return locales.filter(
    (locale) =>
      locale !== baseLocale && (!suggestableLocales || suggestableLocales.includes(locale)),
  )
}

/** 候选横幅的显示规则：横幅本身带 hidden 类，只有 <html> 属性与之相符的一条显示为 flex */
export function suggestionCss(targets: readonly string[]): string {
  return targets
    .map(
      (target) =>
        `:root[${SUGGESTION_ATTRIBUTE}=${JSON.stringify(target)}] [${SUGGESTION_TARGET_ATTRIBUTE}=${JSON.stringify(target)}]{display:flex}`,
    )
    .join('')
}
