import type { WaterfallStep } from '@product-res/costing'
import { Chart } from '@product-res/ui'
import { formatMoney } from './format.ts'
import { WATERFALL_LABELS } from './labels.ts'

/**
 * 成本瀑布（specs/costing-matrix「对比矩阵与成本瀑布」）：售价 → 采购 → 头程 → 平台费 → 配送/尾程 →
 * 广告 → 退货预留 → 净利润。横向条形，透明底座 + 成本段叠放，每段从上一步剩余处向左扣减；
 * 亏损时剩余越过 0 的部分截在 0，净利润画成负向红条。
 */

type Tone = 'price' | 'cost' | 'ads' | 'profit' | 'loss'

/** 各段语义色：售价=主色，成本=错误色淡化，广告/退货预留=警告色，盈利=成功色，亏损=错误色 */
const TONES: Record<Tone, { token: string; opacity: number }> = {
  price: { token: '--primary', opacity: 0.85 },
  cost: { token: '--destructive', opacity: 0.75 },
  ads: { token: '--warning', opacity: 0.85 },
  profit: { token: '--success', opacity: 1 },
  loss: { token: '--destructive', opacity: 1 },
}

/** ECharts 只接受具体颜色字符串：渲染时从根元素读取设计 token（服务端无 document，返回空串） */
function token(name: string) {
  if (typeof document === 'undefined') return ''
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

export function waterfallRows(salePriceMinor: number, steps: readonly WaterfallStep[]) {
  let remaining = salePriceMinor
  const rows: { label: string; base: number; value: number; amount: number; tone: Tone }[] = [
    { label: '售价', base: 0, value: salePriceMinor, amount: salePriceMinor, tone: 'price' },
  ]
  for (const step of steps) {
    if (step.key === 'netProfit') {
      rows.push({
        label: WATERFALL_LABELS.netProfit,
        base: 0,
        value: step.amountMinor,
        amount: step.amountMinor,
        tone: step.amountMinor >= 0 ? 'profit' : 'loss',
      })
      continue
    }
    const top = remaining
    remaining -= step.amountMinor
    const hi = Math.max(0, Math.max(top, remaining))
    const lo = Math.max(0, Math.min(top, remaining))
    rows.push({
      label: WATERFALL_LABELS[step.key],
      base: lo,
      value: hi - lo,
      amount: -step.amountMinor,
      tone: step.key === 'ads' || step.key === 'returns' ? 'ads' : 'cost',
    })
  }
  return rows
}

function option(salePriceMinor: number, steps: readonly WaterfallStep[], currency: string) {
  const rows = waterfallRows(salePriceMinor, steps)
  const major = (minor: number) => Math.round(minor) / 100
  return {
    animationDuration: 300,
    grid: { left: 72, right: 92, top: 8, bottom: 8 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: Array<{ dataIndex: number }>) => {
        const row = rows[params[0]?.dataIndex ?? 0]
        if (!row) return ''
        const share =
          salePriceMinor > 0
            ? ` · ${((Math.abs(row.amount) / salePriceMinor) * 100).toFixed(1)}%`
            : ''
        return `${row.label}：${formatMoney(row.amount, currency)}${row.label === '售价' ? '' : share}`
      },
    },
    xAxis: { type: 'value', show: false, max: major(salePriceMinor) },
    yAxis: {
      type: 'category',
      inverse: true,
      data: rows.map((r) => r.label),
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: {
        fontSize: 12,
        color: token('--subtle-foreground'),
        fontWeight: (v: string) => (v === '净利润' ? 600 : 400),
      },
    },
    series: [
      {
        type: 'bar',
        stack: 'waterfall',
        silent: true,
        itemStyle: { color: 'transparent' },
        data: rows.map((r) => major(r.base)),
      },
      {
        type: 'bar',
        stack: 'waterfall',
        barWidth: 14,
        data: rows.map((r) => ({
          value: major(r.value),
          itemStyle: {
            color: token(TONES[r.tone].token),
            borderRadius: 3,
            opacity: TONES[r.tone].opacity,
          },
        })),
        label: {
          show: true,
          position: 'right',
          fontSize: 12,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          formatter: ({ dataIndex }: { dataIndex: number }) => {
            const row = rows[dataIndex]
            if (!row) return ''
            const text = formatMoney(Math.abs(row.amount), null)
            return row.label === '售价' || row.amount >= 0 ? text : `-${text}`
          },
          color: token('--foreground'),
        },
      },
    ],
  }
}

export function CostWaterfall({
  salePriceMinor,
  steps,
  currency,
}: {
  salePriceMinor: number
  steps: readonly WaterfallStep[]
  currency: string
}) {
  return (
    <div data-testid="cost-waterfall">
      <Chart
        option={option(salePriceMinor, steps, currency)}
        empty={salePriceMinor <= 0 || steps.length === 0}
        height={8 * 34 + 16}
        aria-label="成本瀑布"
      />
    </div>
  )
}
