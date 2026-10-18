import { describe, expect, it } from 'vitest'
import { activeNavKey, WORKBENCH_NAV } from './nav.ts'

describe('工作台导航', () => {
  it('按方案顺序提供七个一级导航，不含评审中心', () => {
    expect(WORKBENCH_NAV.map((item) => item.label)).toEqual([
      '工作台',
      '跟卖选品',
      '品牌选品',
      '选品档案库',
      '算法验证',
      '数据中心',
      '设置',
    ])
    expect(WORKBENCH_NAV.some((item) => item.label.includes('评审'))).toBe(false)
  })

  it('按路径高亮当前导航', () => {
    expect(activeNavKey('/app/acme', 'acme')).toBe('home')
    expect(activeNavKey('/app/acme/', 'acme')).toBe('home')
    expect(activeNavKey('/app/acme/follow/clusters/1', 'acme')).toBe('follow')
    expect(activeNavKey('/app/acme/data', 'acme')).toBe('data')
    expect(activeNavKey('/app/acme/settings', 'acme')).toBeNull()
    expect(activeNavKey('/app/acme/dataset', 'acme')).toBeNull()
    expect(activeNavKey('/admin', 'acme')).toBeNull()
  })
})
