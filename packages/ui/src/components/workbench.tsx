import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../lib/utils.ts'

/** 算法准备度（docs/plan/selection-workbench.md §11.2） */
export type Readiness = 'cold-start' | 'observing' | 'usable' | 'trusted'
export type Grade = 'recommend' | 'caution' | 'reject' | 'unverified'

export const GRADE_LABELS: Record<Grade, string> = {
  recommend: '推荐',
  caution: '谨慎',
  reject: '不推荐',
  unverified: '未验证',
}

/** 推荐 ≥ 75、谨慎 50–74、不推荐 < 50；冷启动不给等级。分数缺失同样视为未验证。 */
export function gradeOf(score: number | null | undefined, readiness: Readiness): Grade {
  if (readiness === 'cold-start' || score == null || Number.isNaN(score)) return 'unverified'
  if (score >= 75) return 'recommend'
  if (score >= 50) return 'caution'
  return 'reject'
}

const tone = {
  success: 'bg-success-soft text-success-strong border-success/30',
  warning: 'bg-warning-soft text-warning-strong border-warning/30',
  danger: 'bg-destructive-soft text-destructive border-destructive/30',
  info: 'bg-primary-soft text-primary border-primary/30',
  neutral: 'bg-muted text-muted-foreground border-border',
} as const
export type Tone = keyof typeof tone

const gradeTone: Record<Grade, Tone> = {
  recommend: 'success',
  caution: 'warning',
  reject: 'danger',
  unverified: 'neutral',
}

export function Tag({
  tone: t = 'neutral',
  className,
  ...props
}: ComponentProps<'span'> & { tone?: Tone }) {
  return (
    <span
      data-slot="tag"
      data-tone={t}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        tone[t],
        className,
      )}
      {...props}
    />
  )
}

export function GradeTag({
  score,
  readiness,
  className,
}: {
  score: number | null | undefined
  readiness: Readiness
  className?: string
}) {
  const grade = gradeOf(score, readiness)
  return (
    <Tag tone={gradeTone[grade]} data-grade={grade} className={className}>
      {GRADE_LABELS[grade]}
      {grade !== 'unverified' && score != null ? (
        <span className="font-mono">{Math.round(score)}</span>
      ) : null}
    </Tag>
  )
}

/** 线索状态（§2） */
export type LeadStatus =
  | 'new'
  | 'watching'
  | 'costing'
  | 'pending-decision'
  | 'following'
  | 'listed'
  | 'reviewed'
  | 'snoozed'
  | 'ignored'
  | 'abandoned'

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: '新线索',
  watching: '关注',
  costing: '核算中',
  'pending-decision': '待决定',
  following: '跟卖',
  listed: '已上架',
  reviewed: '已回看',
  snoozed: '稍后',
  ignored: '忽略',
  abandoned: '放弃',
}

const statusTone: Record<LeadStatus, Tone> = {
  new: 'info',
  watching: 'info',
  costing: 'warning',
  'pending-decision': 'warning',
  following: 'success',
  listed: 'success',
  reviewed: 'neutral',
  snoozed: 'neutral',
  ignored: 'neutral',
  abandoned: 'danger',
}

export function StatusTag({ status, className }: { status: LeadStatus; className?: string }) {
  return (
    <Tag tone={statusTone[status]} data-status={status} className={className}>
      {LEAD_STATUS_LABELS[status]}
    </Tag>
  )
}

export type RiskLevel = 'high' | 'medium' | 'low' | 'hint'
const riskTone: Record<RiskLevel, Tone> = {
  high: 'danger',
  medium: 'warning',
  low: 'info',
  hint: 'neutral',
}
const RISK_LABELS: Record<RiskLevel, string> = { high: '高', medium: '中', low: '低', hint: '提示' }

/** 风险卡片；veto 表示一票否决，必须与普通高风险在视觉上区分 */
export function RiskCard({
  level,
  title,
  veto = false,
  children,
  className,
}: {
  level: RiskLevel
  title: ReactNode
  veto?: boolean
  children?: ReactNode
  className?: string
}) {
  return (
    <div
      data-slot="risk-card"
      data-level={level}
      data-veto={veto || undefined}
      className={cn(
        'grid gap-1 rounded-lg border-l-4 bg-card p-3 text-sm',
        veto
          ? 'border-destructive bg-destructive-soft'
          : level === 'high'
            ? 'border-destructive'
            : level === 'medium'
              ? 'border-warning'
              : 'border-border',
        className,
      )}
    >
      <div className="flex items-center gap-2 font-medium">
        {veto ? (
          <Tag tone="danger">一票否决</Tag>
        ) : (
          <Tag tone={riskTone[level]}>{RISK_LABELS[level]}</Tag>
        )}
        <span>{title}</span>
      </div>
      {children ? <div className="text-muted-foreground">{children}</div> : null}
    </div>
  )
}

/** 置信度条：value 为 0–1；缺失时显示“无数据”而不是 0 */
export function ConfidenceBar({
  value,
  label = '置信度',
  className,
}: {
  value: number | null | undefined
  label?: string
  className?: string
}) {
  const missing = value == null || Number.isNaN(value)
  const pct = missing ? 0 : Math.round(Math.min(1, Math.max(0, value)) * 100)
  const level = missing ? '无数据' : pct >= 70 ? '高' : pct >= 40 ? '中' : '低'
  return (
    <div data-slot="confidence" className={cn('grid gap-1 text-xs', className)}>
      <div className="flex justify-between text-muted-foreground">
        <span>{label}</span>
        <span data-testid="confidence-level">{missing ? level : `${level} · ${pct}%`}</span>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: 原生 <meter> 无法按主题色分档着色，这里用带 ARIA 的自定义条 */}
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={missing ? undefined : pct}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        {missing ? null : (
          <div
            className={cn(
              'h-full rounded-full',
              pct >= 70 ? 'bg-success' : pct >= 40 ? 'bg-warning' : 'bg-destructive',
            )}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
    </div>
  )
}

/** 获取方式（§1 原则 6） */
export type AcquisitionMethod = 'official' | 'estimate' | 'derived' | 'import'
export const ACQUISITION_LABELS: Record<AcquisitionMethod, string> = {
  official: '官方',
  estimate: '估算',
  derived: '推算',
  import: '导入',
}
const methodTone: Record<AcquisitionMethod, Tone> = {
  official: 'success',
  estimate: 'info',
  derived: 'warning',
  import: 'neutral',
}

export function SourceBadge({
  method,
  source,
  className,
}: {
  method: AcquisitionMethod
  source?: string
  className?: string
}) {
  return (
    <Tag tone={methodTone[method]} data-method={method} className={className}>
      {ACQUISITION_LABELS[method]}
      {source ? <span className="font-normal opacity-80">· {source}</span> : null}
    </Tag>
  )
}

/** 统计卡（设计稿 dash-stat-card）；value 缺失时显示“—” */
export function StatCard({
  label,
  value,
  hint,
  className,
}: {
  label: ReactNode
  value: ReactNode | null | undefined
  hint?: ReactNode
  className?: string
}) {
  return (
    <div
      data-slot="stat-card"
      className={cn('grid gap-1 rounded-xl border bg-card p-4 shadow-xs', className)}
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-bold leading-tight">{value ?? '—'}</div>
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  )
}
