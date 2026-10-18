import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfidenceBar, GradeTag, gradeOf, RiskCard, SourceBadge, StatCard } from '../src/index.ts'

afterEach(cleanup)

describe('gradeOf', () => {
  it('按 75 / 50 阈值分级', () => {
    expect(gradeOf(75, 'usable')).toBe('recommend')
    expect(gradeOf(74, 'usable')).toBe('caution')
    expect(gradeOf(50, 'observing')).toBe('caution')
    expect(gradeOf(49, 'trusted')).toBe('reject')
  })

  it('冷启动或缺少分数时为未验证', () => {
    expect(gradeOf(90, 'cold-start')).toBe('unverified')
    expect(gradeOf(null, 'usable')).toBe('unverified')
    expect(gradeOf(Number.NaN, 'usable')).toBe('unverified')
  })
})

describe('GradeTag', () => {
  it('显示等级与分数', () => {
    render(<GradeTag score={75} readiness="usable" />)
    expect(screen.getByText('推荐')).toBeTruthy()
    expect(screen.getByText('75')).toBeTruthy()
  })

  it('冷启动只显示未验证，不显示分数', () => {
    const { container } = render(<GradeTag score={88} readiness="cold-start" />)
    expect(container.textContent).toBe('未验证')
  })

  it('调用方给出的等级优先：冷启动下硬门槛不通过仍显示不推荐', () => {
    const { container } = render(<GradeTag score={null} readiness="cold-start" grade="reject" />)
    expect(container.textContent).toBe('不推荐')
  })
})

describe('ConfidenceBar', () => {
  it('缺失时显示无数据而不是 0', () => {
    render(<ConfidenceBar value={null} />)
    expect(screen.getByTestId('confidence-level').textContent).toBe('无数据')
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBeNull()
  })

  it('按百分比分档', () => {
    render(<ConfidenceBar value={0.72} />)
    expect(screen.getByTestId('confidence-level').textContent).toBe('高 · 72%')
  })
})

describe('RiskCard / SourceBadge / StatCard', () => {
  it('一票否决与普通高风险区分', () => {
    render(<RiskCard level="high" veto title="命中 VeRO 名单" />)
    expect(screen.getByText('一票否决')).toBeTruthy()
  })

  it('来源徽标显示获取方式', () => {
    render(<SourceBadge method="derived" source="eBay Browse" />)
    expect(screen.getByText('推算')).toBeTruthy()
  })

  it('统计卡缺值显示占位符', () => {
    render(<StatCard label="今日调用" value={null} />)
    expect(screen.getByText('—')).toBeTruthy()
  })
})
