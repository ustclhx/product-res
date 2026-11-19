import { Button } from '@product-res/ui'
import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import type { DailyCreditsCheck } from './daily.server.ts'

type Granted = Extract<DailyCreditsCheck, { status: 'granted' }>

/** 由 UI 设计任务替换展示，领取和去重仍归 App 数据层。 */
export function DailyGrantNotice({
  credits,
  daysThisMonth,
  maxDaysPerMonth,
  expiresAt,
  onDismiss,
}: Omit<Granted, 'status' | 'grantId' | 'day'> & { onDismiss(): void }) {
  return (
    <section role="status" className="grid gap-2 rounded-xl border p-4">
      <p>{m.daily_credits_granted({ credits, daysThisMonth, maxDaysPerMonth })}</p>
      <p>{m.daily_credits_expiry({ expiresAt })}</p>
      <Button type="button" variant="outline" onClick={onDismiss}>
        {m.daily_credits_dismiss()}
      </Button>
    </section>
  )
}

export function DailyCreditsNotice({ result }: { result: DailyCreditsCheck | null }) {
  const [notice, setNotice] = useState<Granted | null>(null)
  useEffect(() => {
    if (result?.status !== 'granted') return
    // sessionStorage 不可用时保留本次通知，避免影响 App 的其他功能。
    try {
      const key = `daily-credits-notice:${result.grantId}`
      if (sessionStorage.getItem(key)) return
      sessionStorage.setItem(key, 'shown')
    } catch {
      // 浏览器隐私策略可能拒绝存储。
    }
    setNotice(result)
  }, [result])

  if (result?.status === 'unverified')
    return (
      <p role="status">
        <Link to="/account" className="underline">
          {m.daily_credits_verify()}
        </Link>
      </p>
    )
  return notice ? <DailyGrantNotice {...notice} onDismiss={() => setNotice(null)} /> : null
}
