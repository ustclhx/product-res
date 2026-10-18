import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Chart } from '../src/index.ts'

afterEach(cleanup)

describe('Chart', () => {
  it('空数据时显示暂无数据，不初始化图表', () => {
    render(<Chart aria-label="销量曲线" empty option={{ series: [] }} />)
    const el = screen.getByRole('img', { name: '销量曲线' })
    expect(el.textContent).toBe('暂无数据')
    expect(el.getAttribute('data-slot')).toBe('chart-empty')
  })
})
