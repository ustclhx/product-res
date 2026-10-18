import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { THEME_STORAGE_KEY, ThemeToggle, themeInitScript } from '../src/index.ts'

const labels = { group: 'Theme', light: 'Light', dark: 'Dark', system: 'System' }

// happy-dom 的 matchMedia 不跟随系统设置：按测试需要模拟系统是否为深色
function mockSystemDark(dark: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: dark,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
}

function runInitScript() {
  new Function(themeInitScript())()
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.className = ''
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('首屏前内联脚本', () => {
  it('未设置偏好时跟随系统', () => {
    mockSystemDark(true)
    runInitScript()
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    document.documentElement.className = ''
    mockSystemDark(false)
    runInitScript()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('已保存的偏好优先于系统设置', () => {
    mockSystemDark(false)
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    runInitScript()
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    mockSystemDark(true)
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    runInitScript()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})

describe('ThemeToggle', () => {
  it('切换后更新 <html> 类名与 localStorage，选择跟随系统时清除偏好', async () => {
    mockSystemDark(false)
    render(<ThemeToggle labels={labels} />)
    expect(screen.getByRole('button', { name: 'System' }).getAttribute('aria-pressed')).toBe('true')

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Dark' })))
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(screen.getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe('true')

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Light' })))
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'System' })))
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
  })

  it('挂载时读取已保存的偏好', () => {
    mockSystemDark(false)
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    render(<ThemeToggle labels={labels} />)
    expect(screen.getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('服务端渲染时按跟随系统输出，不访问浏览器存储', () => {
    const html = renderToString(<ThemeToggle labels={labels} />)
    expect(html).toMatch(/aria-pressed="true" disabled="" data-theme-option="system"/)
  })
})
