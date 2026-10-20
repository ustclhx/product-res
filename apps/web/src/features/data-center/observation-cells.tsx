import { formatInterval } from '@product-res/datasources'
import { Tag } from '@product-res/ui'
import { m } from '../../paraglide/messages.js'

/**
 * 观测的可信度层级与区间展示（add-accuracy-store-tracking design D1 / D8）。
 * 区间按 "100–200" 显示，上界开放时 "10K+"；点值没有区间，显示 "—"。
 */

const TIER_LABEL = [
  m.accuracy_tier_0,
  m.accuracy_tier_1,
  m.accuracy_tier_2,
  m.accuracy_tier_3,
  m.accuracy_tier_4,
]
const TIER_TONE = ['success', 'success', 'info', 'warning', 'neutral'] as const

export function TierTag({ tier }: { tier: number }) {
  const label = TIER_LABEL[tier]
  if (!label) return <span>—</span>
  return (
    <Tag tone={TIER_TONE[tier] ?? 'neutral'} title={label()} data-tier={tier}>
      T{tier}
    </Tag>
  )
}

/** 区间文本；没有下界（点值）时为 "—" */
export function intervalText(low: number | null | undefined, high: number | null | undefined) {
  return low === null || low === undefined ? '—' : formatInterval(low, high ?? null)
}

export function IntervalCell({ low, high }: { low: number | null; high: number | null }) {
  return <span className="font-mono">{intervalText(low, high)}</span>
}

export function ChannelTag({ channel }: { channel: string | null | undefined }) {
  if (!channel) return null
  return (
    <Tag tone="info" data-channel={channel}>
      {channel === 'aisa'
        ? m.accuracy_channel_aisa()
        : channel === 'direct'
          ? m.accuracy_channel_direct()
          : channel}
    </Tag>
  )
}
