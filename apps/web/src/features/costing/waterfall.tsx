import type { WaterfallStep } from '@product-res/costing'
import { Chart } from '@product-res/ui'
import { formatMoney } from './format.ts'
import { WATERFALL_LABELS } from './labels.ts'

/**
 * 成本瀑布（specs/costing-matrix「对比矩阵与成本瀑布」）：售价 → 采购 → 头程 → 平台费 → 配送/尾程 →
 * 广告 → 退货预留 → 净利润。横向条形，透明底座 + 成本段叠放，每段从上一步剩余处向左扣减；
 * 亏损时剩余越过 0 的部分截在 0，净利润画成负向红条。
 */

const COLORS = {
  price: '#1677ff',
  cost: '#ff7875',
  ads: '#ffc53d',
  profit: '#52c41a',
  loss: '#ff4d4f',
}

export function waterfallRows(salePriceMinor: number, steps: readonly WaterfallStep[]) {
  let remaining = salePriceMinor
  const rows: { label: string; base: number; value: number; amount: number; color: string }[] = [
    { label: '售价', base: 0, value: salePriceMinor, amount: salePriceMinor, color: COLORS.price },
  ]
  for (const step of steps) {
    if (step.key === 'netProfit') {
      rows.push({
        label: WATERFALL_LABELS.netProfit,
        base: 0,
        value: step.amountMinor,
        amount: step.amountMinor,
        color: step.amountMinor >= 0 ? COLORS.profit : COLORS.loss,
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
      color: step.key === 'ads' || step.key === 'returns' ? COLORS.ads : COLORS.cost,
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
        color: '#595959',
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
          itemStyle: { color: r.color, borderRadius: 3, opacity: r.label === '售价' ? 0.85 : 1 },
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
          color: '#262626',
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
