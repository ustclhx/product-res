import { Chart } from '@product-res/ui'
import { useMemo } from 'react'
import { fmtCompact, fmtMoney, fmtPercent } from './format.ts'
import type { MatrixRowView, PriceBandView, ReviewView, TrendPointView } from './types.ts'

/**
 * 报告页图表（ECharts）。按 dataviz 规范：单一 y 轴（搜索量与销量估算量纲不同，拆成两张小图）、
 * 细线 2px、轴线与网格弱化、悬停提示；缺月不补 0，曲线在缺口处断开。
 */

/**
 * canvas 不认 CSS 变量，配置里的颜色在运行时从 :root 读取设计 token。
 * 图表只在客户端 effect 中渲染，服务端渲染时读不到 document，返回空串即可（option 不会被使用）。
 */
function token(name: string) {
  if (typeof document === 'undefined') return ''
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim()
}

function axis() {
  const border = token('border')
  return {
    axisLine: { lineStyle: { color: border } },
    axisTick: { show: false },
    axisLabel: { color: token('muted-foreground'), fontSize: 11 },
    splitLine: { lineStyle: { color: border, type: 'dashed' as const } },
  }
}
// 提示框是普通 DOM 元素，extraCssText 与 formatter 生成的 HTML 可以直接用 var()
function tooltip() {
  return {
    backgroundColor: token('card'),
    borderColor: token('border'),
    textStyle: { color: token('foreground'), fontSize: 12 },
    extraCssText: 'box-shadow:var(--shadow-4);border-radius:8px;',
  }
}

const monthLabel = (m: string) => `${Number(m.slice(5))}月`

export function TrendChart({
  points,
  metric,
  tone,
  label,
  nodeLabels = true,
}: {
  points: readonly TrendPointView[]
  metric: 'searchVolume' | 'salesEstimate'
  /** 曲线颜色对应的设计 token */
  tone: 'primary' | 'success'
  label: string
  /** 两张小图上下排列时只在上面一张写节点名，避免重复 */
  nodeLabels?: boolean
}) {
  const option = useMemo(() => {
    const color = token(tone)
    const AXIS = axis()
    const months = points.map((p) => p.month)
    // 同月多个节点合并为一条线，名称用顿号连接
    const nodes = points
      .filter((p) => p.nodes.length > 0)
      .map((p) => ({ month: p.month, label: [...new Set(p.nodes.map((n) => n.label))].join('、') }))
    return {
      grid: { left: 44, right: 16, top: nodes.length && nodeLabels ? 30 : 12, bottom: 24 },
      tooltip: {
        ...tooltip(),
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: token('muted-foreground') } },
        formatter: (items: { dataIndex: number; value: number | null }[]) => {
          const p = points[items[0]?.dataIndex ?? 0]
          if (!p) return ''
          const v = items[0]?.value
          const node = p.nodes.length
            ? `<br/><span style="color:var(--warning-strong)">节点：${p.nodes.map((n) => n.label).join('、')}</span>`
            : ''
          return `${p.month}<br/>${label} ${v == null ? '无数据' : fmtCompact(v)}${node}`
        },
      },
      xAxis: {
        type: 'category',
        data: months,
        boundaryGap: false,
        ...AXIS,
        splitLine: { show: false },
        axisLabel: { ...AXIS.axisLabel, formatter: monthLabel },
      },
      yAxis: {
        type: 'value',
        ...AXIS,
        axisLine: { show: false },
        axisLabel: { ...AXIS.axisLabel, formatter: (v: number) => fmtCompact(v) },
      },
      series: [
        {
          name: label,
          type: 'line',
          data: points.map((p) => p[metric]),
          connectNulls: false,
          symbol: 'circle',
          symbolSize: 6,
          showSymbol: true,
          lineStyle: { width: 2, color },
          itemStyle: { color, borderColor: token('card'), borderWidth: 2 },
          // 原为曲线色 20% 透明度渐变到 0；token 可能不是十六进制，改用整体 opacity 表达
          areaStyle: {
            opacity: 0.2,
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color },
                { offset: 1, color: 'transparent' },
              ],
            },
          },
          markLine: nodes.length
            ? {
                silent: true,
                symbol: 'none',
                lineStyle: { color: token('warning'), type: 'dashed', width: 1 },
                label: {
                  show: nodeLabels,
                  position: 'end',
                  color: token('warning-strong'),
                  fontSize: 10,
                  // 标签横排在线顶端；过长时截断，完整名称见悬停提示
                  formatter: (p: { name: string }) =>
                    p.name.length > 6 ? `${p.name.slice(0, 6)}…` : p.name,
                },
                data: nodes.map((n) => ({ xAxis: n.month, name: n.label })),
              }
            : undefined,
        },
      ],
    }
  }, [points, metric, tone, label, nodeLabels])
  const empty = points.every((p) => p[metric] === null)
  return <Chart option={option} empty={empty} height={170} aria-label={`${label}近 12 个月趋势`} />
}

export function PriceBandChart({
  bands,
  currency,
}: {
  bands: readonly PriceBandView[]
  currency: string | null
}) {
  const option = useMemo(() => {
    const names = bands.map((b) =>
      b.min === null
        ? `< ${fmtMoney(b.max, currency)}`
        : b.max === null
          ? `≥ ${fmtMoney(b.min, currency)}`
          : `${fmtMoney(b.min, currency)}–${fmtMoney(b.max, currency)}`,
    )
    // 有销量估算时柱高表示销量占比（更能说明钱在哪个价位），否则退回商品数
    const byShare = bands.some((b) => b.salesShare !== null)
    const AXIS = axis()
    return {
      grid: { left: 36, right: 12, top: 16, bottom: 28 },
      tooltip: {
        ...tooltip(),
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: token('primary'), opacity: 0.06 } },
        formatter: (items: { dataIndex: number }[]) => {
          const b = bands[items[0]?.dataIndex ?? 0]
          if (!b) return ''
          return `${names[items[0]?.dataIndex ?? 0]}<br/>商品 ${b.productCount} 个<br/>销量占比 ${b.salesShare == null ? '无销量估算' : fmtPercent(b.salesShare, 1)}`
        },
      },
      xAxis: {
        type: 'category',
        data: names,
        ...AXIS,
        axisLabel: { ...AXIS.axisLabel, fontSize: 10, interval: 0 },
      },
      yAxis: {
        type: 'value',
        ...(byShare
          ? { max: (v: { max: number }) => Math.min(1, v.max * 1.2) }
          : { minInterval: 1 }),
        ...AXIS,
        axisLine: { show: false },
        axisLabel: {
          ...AXIS.axisLabel,
          formatter: (v: number) => (byShare ? fmtPercent(v) : String(v)),
        },
      },
      series: [
        {
          name: byShare ? '销量占比' : '商品数',
          type: 'bar',
          barMaxWidth: 32,
          data: bands.map((b) => (byShare ? (b.salesShare ?? 0) : b.productCount)),
          itemStyle: { color: token('primary'), borderRadius: [4, 4, 0, 0] },
          label: {
            show: true,
            position: 'top',
            color: token('subtle-foreground'),
            fontSize: 10,
            formatter: (p: { dataIndex: number }) => {
              const b = bands[p.dataIndex]
              if (!b) return ''
              return byShare
                ? `${fmtPercent(b.salesShare)} · ${b.productCount} 个`
                : `${b.productCount} 个`
            },
          },
        },
      ],
    }
  }, [bands, currency])
  return <Chart option={option} empty={bands.length === 0} height={240} aria-label="价格带分布" />
}

export function BubbleChart({
  rows,
  bubbles,
  currency,
}: {
  rows: readonly MatrixRowView[]
  bubbles: readonly { id: string; x: number; y: number; size: number | null }[]
  currency: string | null
}) {
  const option = useMemo(() => {
    const titles = new Map(rows.map((r) => [r.id, r.title ?? r.platformId]))
    const maxSize = Math.max(1, ...bubbles.map((b) => b.size ?? 0))
    const AXIS = axis()
    const primary = token('primary')
    return {
      grid: { left: 48, right: 16, top: 16, bottom: 36 },
      tooltip: {
        ...tooltip(),
        trigger: 'item',
        formatter: (p: { data: [number, number, number | null, string] }) => {
          const [x, y, size, id] = p.data
          const title = String(titles.get(id) ?? id)
          return `<div style="max-width:240px;white-space:normal">${title.replace(/</g, '&lt;')}</div>价格 ${fmtMoney(x, currency)} · 月销量 ${fmtCompact(y)}<br/>评论数 ${size == null ? '无数据' : fmtCompact(size)}`
        },
      },
      xAxis: {
        type: 'value',
        name: '价格',
        nameLocation: 'middle',
        nameGap: 24,
        nameTextStyle: { color: AXIS.axisLabel.color, fontSize: 11 },
        scale: true,
        ...AXIS,
        axisLabel: { ...AXIS.axisLabel, formatter: (v: number) => fmtMoney(v, currency) },
      },
      yAxis: {
        type: 'value',
        name: '月销量估算',
        nameTextStyle: { color: AXIS.axisLabel.color, fontSize: 11, align: 'left' },
        ...AXIS,
        axisLine: { show: false },
        axisLabel: { ...AXIS.axisLabel, formatter: (v: number) => fmtCompact(v) },
      },
      series: [
        {
          type: 'scatter',
          data: bubbles.map((b) => [b.x, b.y, b.size, b.id]),
          // 面积与评论数成正比；缺评论数时用最小尺寸，不当作 0
          symbolSize: (d: [number, number, number | null]) =>
            d[2] == null ? 10 : 10 + 34 * Math.sqrt(d[2] / maxSize),
          // 原为主色 55% 透明填充；token 可能不是十六进制，改用 opacity（白边随之半透明）
          itemStyle: {
            color: primary,
            opacity: 0.55,
            borderColor: token('card'),
            borderWidth: 2,
          },
          emphasis: { itemStyle: { color: primary, opacity: 1 } },
        },
      ],
    }
  }, [rows, bubbles, currency])
  return (
    <Chart
      option={option}
      empty={bubbles.length === 0}
      height={260}
      aria-label="价格 × 月销量气泡图"
    />
  )
}

/** 词频由高到低的颜色；深红 red-7 与橙 orange-6 没有对应 token，保留设计稿色值（已登记例外） */
function cloudColors() {
  return [
    '#cf1322',
    token('destructive'),
    token('warning-strong'),
    '#fa8c16',
    token('muted-foreground'),
  ]
}

export function WordCloud({
  terms,
  reviews,
}: {
  terms: readonly { term: string; count: number; reviewIds: string[] }[]
  reviews: Readonly<Record<string, ReviewView>>
}) {
  const option = useMemo(() => {
    const max = Math.max(1, ...terms.map((t) => t.count))
    const colors = cloudColors()
    return {
      tooltip: {
        ...tooltip(),
        formatter: (p: { name: string; value: number; dataIndex: number }) => {
          const sample = terms[p.dataIndex]?.reviewIds.map((id) => reviews[id]?.body).find(Boolean)
          return `${p.name} · ${p.value} 条差评${sample ? `<div style="max-width:240px;white-space:normal;color:var(--muted-foreground)">“${sample.slice(0, 80).replace(/</g, '&lt;')}”</div>` : ''}`
        },
      },
      series: [
        {
          type: 'wordCloud',
          shape: 'square',
          shrinkToFit: true,
          width: '100%',
          height: '100%',
          sizeRange: [14, 40],
          rotationRange: [0, 0],
          gridSize: 6,
          textStyle: {
            // canvas 不认 inherit（会退回 10px 默认字体），显式给出字体栈
            fontFamily: "'Inter Variable', 'PingFang SC', 'Microsoft YaHei', sans-serif",
            fontWeight: 600,
            color: (p: { value: number }) =>
              colors[Math.min(4, Math.floor((1 - p.value / max) * 5))] as string,
          },
          data: terms.map((t) => ({ name: t.term, value: t.count })),
        },
      ],
    }
  }, [terms, reviews])
  return (
    <Chart
      option={option}
      empty={terms.length === 0}
      wordCloud
      height={180}
      aria-label="差评高频词词云"
    />
  )
}
