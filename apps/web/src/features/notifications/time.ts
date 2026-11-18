import { m } from '../../paraglide/messages.js'
import type { Locale } from '../../paraglide/runtime.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const pad = (value: number) => String(value).padStart(2, '0')

/** 中文里数字与汉字之间加空格（「3 分钟前」），与同一弹层的「3 条未读」一致 */
function spaceCjk(text: string) {
  return text.replace(/(\d)([一-鿿])/g, '$1 $2').replace(/([一-鿿])(\d)/g, '$1 $2')
}

/**
 * 通知时间的相对显示（仓库里还没有通用的相对时间工具）：一分钟内「刚刚」，一小时内按分钟、一天内按小时，
 * 1 天为「昨天」、2–6 天为「N 天前」，更早显示日期（中文为 11-08，跨年时 2025-11-08；其他语言用 Intl 的月/日）。
 * 只在浏览器端渲染（弹层打开后才出现），不涉及水合差异。
 */
export function relativeTime(value: Date | string, locale: Locale, now: Date = new Date()) {
  const date = typeof value === 'string' ? new Date(value) : value
  const diff = now.getTime() - date.getTime()
  if (Number.isNaN(diff)) return ''
  if (diff < MINUTE) return m.notifications_just_now({}, { locale })
  const zh = locale.startsWith('zh')
  const format = (
    amount: number,
    unit: Intl.RelativeTimeFormatUnit,
    numeric: 'auto' | 'always',
  ) => {
    const text = new Intl.RelativeTimeFormat(locale, { numeric }).format(-amount, unit)
    return zh ? spaceCjk(text) : text
  }
  if (diff < HOUR) return format(Math.floor(diff / MINUTE), 'minute', 'always')
  if (diff < DAY) return format(Math.floor(diff / HOUR), 'hour', 'always')
  const days = Math.floor(diff / DAY)
  // numeric: 'auto' 只用于「昨天」，2 天不显示为「前天」
  if (days < 7) return format(days, 'day', days === 1 ? 'auto' : 'always')
  const sameYear = date.getFullYear() === now.getFullYear()
  if (zh) {
    const monthDay = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    return sameYear ? monthDay : `${date.getFullYear()}-${monthDay}`
  }
  return new Intl.DateTimeFormat(locale, {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}
