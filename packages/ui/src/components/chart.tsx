import { BarChart, LineChart, RadarChart, ScatterChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  RadarComponent,
  TooltipComponent,
} from 'echarts/components'
import type { EChartsCoreOption } from 'echarts/core'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { useEffect, useRef } from 'react'
import { cn } from '../lib/utils.ts'

echarts.use([
  BarChart,
  LineChart,
  RadarChart,
  ScatterChart,
  GridComponent,
  LegendComponent,
  RadarComponent,
  TooltipComponent,
  CanvasRenderer,
])

/** 设计稿配色（docs/design）：主色、成功、警告、错误、紫、青 */
export const CHART_COLORS = ['#1677ff', '#52c41a', '#faad14', '#ff4d4f', '#722ed1', '#13c2c2']

let wordCloudLoaded: Promise<unknown> | null = null
/** 词云扩展按需加载，只有用到词云的页面才下载 */
function loadWordCloud() {
  wordCloudLoaded ??= import('echarts-wordcloud')
  return wordCloudLoaded
}

export interface ChartProps {
  option: EChartsCoreOption
  /** 为 true 时显示“暂无数据”，不渲染空坐标轴或零值曲线 */
  empty: boolean
  /** 使用词云系列时设为 true */
  wordCloud?: boolean
  height?: number
  className?: string
  'aria-label': string
}

/** 统一图表容器：自适应宽度、主题色、空数据态 */
export function Chart({
  option,
  empty,
  wordCloud = false,
  height = 280,
  className,
  'aria-label': label,
}: ChartProps) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (empty || !el) return
    let disposed = false
    let chart: echarts.ECharts | undefined
    const observer = new ResizeObserver(() => chart?.resize())
    void (wordCloud ? loadWordCloud() : Promise.resolve()).then(() => {
      if (disposed) return
      chart = echarts.init(el, undefined, { renderer: 'canvas' })
      chart.setOption({ color: CHART_COLORS, ...option })
      observer.observe(el)
    })
    return () => {
      disposed = true
      observer.disconnect()
      chart?.dispose()
    }
  }, [option, empty, wordCloud])
  if (empty)
    return (
      <div
        role="img"
        aria-label={label}
        data-slot="chart-empty"
        className={cn(
          'flex items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground',
          className,
        )}
        style={{ height }}
      >
        暂无数据
      </div>
    )
  return (
    <div
      ref={ref}
      role="img"
      aria-label={label}
      data-slot="chart"
      className={cn('w-full', className)}
      style={{ height }}
    />
  )
}
