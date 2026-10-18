import { Chart } from '@product-res/ui'
import { useMemo } from 'react'
import { fmtCompact, fmtMoney, fmtPercent } from './format.ts'
import type { MatrixRowView, PriceBandView, ReviewView, TrendPointView } from './types.ts'

/**
 * 报告页图表（ECharts）。按 dataviz 规范：单一 y 轴（搜索量与销量估算量纲不同，拆成两张小图）、
 * 细线 2px、轴线与网格弱化、悬停提示；缺月不补 0，曲线在缺口处断开。
 */

const AXIS = {
  axisLine: { lineStyle: { color: '#f0f0f0' } },
  axisTick: { show: false },
  axisLabel: { color: '#8c8c8c', fontSize: 11 },
  splitLine: { lineStyle: { color: '#f0f0f0', type: 'dashed' as const } },
}
const TOOLTIP = {
  backgroundColor: '#fff',
  borderColor: '#f0f0f0',
  textStyle: { color: '#262626', fontSize: 12 },
  extraCssText: 'box-shadow:0 6px 16px rgba(0,0,0,.08);border-radius:8px;',
}

const monthLabel = (m: string) => `${Number(m.slice(5))}月`

export function TrendChart({
  points,
  metric,
  color,
  label,
  nodeLabels = true,
}: {
  points: readonly TrendPointView[]
  metric: 'searchVolume' | 'salesEstimate'
  color: string
  label: string
  /** 两张小图上下排列时只在上面一张写节点名，避免重复 */
  nodeLabels?: boolean
}) {
  const option = useMemo(() => {
    const months = points.map((p) => p.month)
    // 同月多个节点合并为一条线，名称用顿号连接
    const nodes = points
      .filter((p) => p.nodes.length > 0)
      .map((p) => ({ month: p.month, label: [...new Set(p.nodes.map((n) => n.label))].join('、') }))
    return {
      grid: { left: 44, right: 16, top: nodes.length && nodeLabels ? 30 : 12, bottom: 24 },
      tooltip: {
        ...TOOLTIP,
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: '#bfbfbf' } },
        formatter: (items: { dataIndex: number; value: number | null }[]) => {
          const p = points[items[0]?.dataIndex ?? 0]
          if (!p) return ''
          const v = items[0]?.value
          const node = p.nodes.length
            ? `<br/><span style="color:#d48806">节点：${p.nodes.map((n) => n.label).join('、')}</span>`
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
          itemStyle: { color, borderColor: '#fff', borderWidth: 2 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: `${color}33` },
                { offset: 1, color: `${color}00` },
              ],
            },
          },
          markLine: nodes.length
            ? {
                silent: true,
                symbol: 'none',
                lineStyle: { color: '#faad14', type: 'dashed', width: 1 },
                label: {
                  show: nodeLabels,
                  position: 'end',
                  color: '#d48806',
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
  }, [points, metric, color, label, nodeLabels])
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
    return {
      grid: { left: 36, right: 12, top: 16, bottom: 28 },
      tooltip: {
        ...TOOLTIP,
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(22,119,255,0.06)' } },
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
          itemStyle: { color: '#1677ff', borderRadius: [4, 4, 0, 0] },
          label: {
            show: true,
            position: 'top',
            color: '#595959',
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
    return {
      grid: { left: 48, right: 16, top: 16, bottom: 36 },
      tooltip: {
        ...TOOLTIP,
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
        nameTextStyle: { color: '#8c8c8c', fontSize: 11 },
        scale: true,
        ...AXIS,
        axisLabel: { ...AXIS.axisLabel, formatter: (v: number) => fmtMoney(v, currency) },
      },
      yAxis: {
        type: 'value',
        name: '月销量估算',
        nameTextStyle: { color: '#8c8c8c', fontSize: 11, align: 'left' },
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
          itemStyle: {
            color: 'rgba(22,119,255,0.55)',
            borderColor: '#fff',
            borderWidth: 2,
          },
          emphasis: { itemStyle: { color: '#1677ff' } },
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

const CLOUD_COLORS = ['#cf1322', '#ff4d4f', '#d48806', '#fa8c16', '#8c8c8c']

export function WordCloud({
  terms,
  reviews,
}: {
  terms: readonly { term: string; count: number; reviewIds: string[] }[]
  reviews: Readonly<Record<string, ReviewView>>
}) {
  const option = useMemo(() => {
    const max = Math.max(1, ...terms.map((t) => t.count))
    return {
      tooltip: {
        ...TOOLTIP,
        formatter: (p: { name: string; value: number; dataIndex: number }) => {
          const sample = terms[p.dataIndex]?.reviewIds.map((id) => reviews[id]?.body).find(Boolean)
          return `${p.name} · ${p.value} 条差评${sample ? `<div style="max-width:240px;white-space:normal;color:#8c8c8c">“${sample.slice(0, 80).replace(/</g, '&lt;')}”</div>` : ''}`
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
              CLOUD_COLORS[Math.min(4, Math.floor((1 - p.value / max) * 5))] as string,
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
