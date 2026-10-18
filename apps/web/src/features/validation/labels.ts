import type { Tone } from '@product-res/ui'

/** 算法验证页的文案与格式（纯函数，组件与测试共用） */

export type ReadinessLevel = 'cold-start' | 'observation' | 'usable' | 'trusted'
export type SampleKindId = 'shadow' | 'replay' | 'import'
export type ReplayStatusId = 'queued' | 'running' | 'deferred' | 'succeeded' | 'failed'

export const LEVEL_LABELS: Record<ReadinessLevel, string> = {
  'cold-start': '冷启动',
  observation: '观察期',
  usable: '可用',
  trusted: '可信',
}

export const LEVEL_TONES: Record<ReadinessLevel, Tone> = {
  'cold-start': 'neutral',
  observation: 'warning',
  usable: 'info',
  trusted: 'success',
}

export const KIND_LABELS: Record<SampleKindId, string> = {
  shadow: '影子推荐',
  replay: '历史回放',
  import: '导入',
}

/** 样本类型的系列色（按固定顺序，经 dataviz 校验脚本检查色觉区分；文字仍用正文色） */
export const KIND_COLORS: Record<SampleKindId, string> = {
  shadow: '#1677ff',
  replay: '#722ed1',
  import: '#08979c',
}

export const REPLAY_STATUS: Record<ReplayStatusId, { label: string; tone: Tone }> = {
  queued: { label: '排队', tone: 'neutral' },
  running: { label: '运行中', tone: 'info' },
  deferred: { label: '已顺延', tone: 'warning' },
  succeeded: { label: '成功', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
}

const ERROR_TEXT: Record<string, string> = {
  KEEPA_API_KEY_MISSING: '未配置 Keepa 凭据',
  KEEPA_KEY_MISSING: '未配置 Keepa 凭据',
  KEEPA_PAYMENT_REQUIRED: 'Keepa 账户余额不足',
  KEEPA_MARKETPLACE_UNSUPPORTED: 'Keepa 不支持该站点',
  BUDGET_SAFETY_LINE: '已到 Keepa 额度安全线，等待额度恢复',
  BUDGET_HARD_CAP: '已到 Keepa 额度硬上限，等待额度恢复',
  BUDGET_DAILY_ALLOWANCE: '今日 Keepa 额度已用完，明日继续',
  BUDGET_PAUSED: 'Keepa 数据源已暂停',
  SOURCE_DISABLED: 'Keepa 数据源未启用',
  REPLAY_NOT_FOUND: '回放记录不存在',
}

/** 回放任务的错误码 → 说明；未知码原样显示，便于排查 */
export function replayErrorText(code: string | null): string | null {
  if (!code) return null
  return ERROR_TEXT[code] ?? code
}

/** 0–1 的比率显示为百分比；缺失显示“—” */
export function pct(value: number | null | undefined, digits = 1): string {
  if (value == null || Number.isNaN(value)) return '—'
  return `${(value * 100).toFixed(digits)}%`
}

/** 样本数：保留最多两位小数（回放 0.5、导入 0.3 的加权和） */
export const samples = (value: number) =>
  new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)

/** 冷启动说明文字 */
export function coldStartText(info: {
  observation: number
  samplesNeeded: number
  dailyShadowRate: number
  estimatedDays: number | null
}): { need: string; eta: string } {
  const need = `每个 平台 × 方向 × 信号类型 组合需要至少 ${info.observation} 个有效样本（T+30 已打标签，影子推荐计 1、历史回放计 0.5、导入计 0.3）才进入观察期；最接近的组合还差 ${samples(info.samplesNeeded)} 个。`
  const eta =
    info.estimatedDays === null
      ? '近 14 天没有新增影子推荐，暂无法估算时间；每日流水线生成线索后开始积累，Amazon 方向可用 Keepa 历史回放提前补充样本。'
      : `按近 14 天每个组合平均每天新增 ${samples(info.dailyShadowRate)} 条影子推荐、再等待 30 天到期打标签估算，约需 ${info.estimatedDays} 天。`
  return { need, eta }
}
