import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  UiRoot,
} from '../src/index.ts'

// Radix 的弹层依赖这些浏览器 API，happy-dom 未实现
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => {}
// happy-dom 的 Web Animations 在卸载时抛出 AbortError；去掉后 motion 退回到 JS 驱动的动画
Reflect.deleteProperty(Element.prototype, 'animate')

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Button（Fluid 适配）', () => {
  it('Fluid 变体名与模板原变体名输出同一套样式', () => {
    const html = renderToString(
      <>
        <Button variant="primary">A</Button>
        <Button variant="tertiary">B</Button>
        <Button variant="outline">C</Button>
      </>,
    )
    expect(html).toMatch(/<button[^>]*class="[^"]*before:bg-primary[^"]*"[^>]*>A<\/button>/)
    const [, tertiary, outline] = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1])
    expect(tertiary).toBe(outline)
  })

  it('加载中禁用并标记 aria-busy，文字保留占位且仍是按钮名称', () => {
    const html = renderToString(<Button loading>Save</Button>)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-busy="true"/)
    expect(html).toContain('<svg aria-hidden="true"')
    // 只用透明度隐藏文字；invisible（visibility:hidden）会让读屏与按名称查找的按钮失去名称
    expect(html).toMatch(/class="[^"]*opacity-0[^"]*">Save<\/span>/)
    expect(html).not.toContain('invisible')
  })

  it('UiRoot 的 shape 与 density 作用于未指定尺寸的按钮', () => {
    const html = renderToString(
      <UiRoot shape="pill" density="compact">
        <Button>Go</Button>
        <Button size="lg">Big</Button>
      </UiRoot>,
    )
    const [compact, large] = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1])
    expect(compact).toContain('h-7')
    expect(compact).toContain('rounded-[20px]')
    expect(large).toContain('h-10')
  })
})

describe('Button asChild 与 UiRoot 受控', () => {
  it('asChild 时样式落在子元素上，内部不包额外节点，加载态不作用于链接', () => {
    const html = renderToString(
      <Button asChild variant="outline" loading>
        <a href="/pricing">Pricing</a>
      </Button>,
    )
    expect(html).toMatch(
      /^<a href="\/pricing" data-slot="button" class="[^"]*before:ring-border[^"]*">Pricing<\/a>$/,
    )
    expect(html).not.toContain('<button')
    expect(html).not.toContain('aria-busy="')
  })

  it('UiRoot 的 shape 与 density 变化后立即生效', () => {
    const view = render(
      <UiRoot shape="rounded">
        <Button>Go</Button>
      </UiRoot>,
    )
    const button = screen.getByRole('button', { name: 'Go' })
    expect(button.className).toContain('rounded-lg')
    view.rerender(
      <UiRoot shape="pill" density="compact">
        <Button>Go</Button>
      </UiRoot>,
    )
    expect(button.className).toContain('rounded-[20px]')
    expect(button.className).toContain('h-7')
  })
})

describe('Dialog（Fluid radix/dialog）', () => {
  it('点击触发器打开，Escape 关闭后焦点回到触发器', async () => {
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Open</Button>
        </DialogTrigger>
        <DialogContent closeLabel="关闭">
          <DialogTitle>Rename project</DialogTitle>
          <DialogDescription>Choose a new name.</DialogDescription>
        </DialogContent>
      </Dialog>,
    )
    const trigger = screen.getByRole('button', { name: 'Open' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveProperty('textContent', expect.stringContaining('Rename project'))
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy()

    fireEvent.keyDown(dialog, { key: 'Escape' })
    // 退场动画结束（或兜底计时器）后卸载，Radix 随后把焦点还给触发器
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })
})

describe('Select（Fluid radix/select）', () => {
  it('服务端渲染占位文字，不访问浏览器 API', () => {
    const html = renderToString(
      <Select>
        <SelectTrigger placeholder="Pick a plan" aria-label="Plan" />
        <SelectContent>
          <SelectItem index={0} value="free">
            Free
          </SelectItem>
        </SelectContent>
      </Select>,
    )
    expect(html).toContain('role="combobox"')
    expect(html).toContain('Pick a plan')
    // 外层包装与触发器可收缩：放进 grid / flex 列时长文字截断而不撑开所在列
    expect(html).toMatch(/^<div class="flex min-w-0 flex-col gap-1">/)
    expect(html).toMatch(/<button[^>]*class="[^"]*\bmax-w-full\b/)
  })

  it('比最小宽度更窄的列：className="min-w-0" 覆盖触发器的最小宽度', () => {
    const html = renderToString(
      <Select>
        <SelectTrigger placeholder="Model" aria-label="Model" className="min-w-0" />
        <SelectContent>
          <SelectItem index={0} value="a">
            A
          </SelectItem>
        </SelectContent>
      </Select>,
    )
    const button = html.match(/<button[^>]*class="([^"]*)"/)?.[1] ?? ''
    expect(button.split(' ')).toContain('min-w-0')
    expect(button).not.toContain('min-w-[160px]')
  })

  it('传 valueLabel 时服务端输出即含选中文字（水合前可见），值为空时仍显示占位文字', () => {
    const options = [
      { value: 'free', label: 'Free' },
      { value: 'pro', label: 'Pro' },
    ]
    const render = (value: string) =>
      renderToString(
        <Select value={value}>
          <SelectTrigger
            placeholder="Pick a plan"
            aria-label="Plan"
            valueLabel={options.find((option) => option.value === value)?.label}
          />
          <SelectContent>
            {options.map((option, index) => (
              <SelectItem key={option.value} index={index} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>,
      )
    const selected = render('pro')
    expect(selected).toContain('Pro')
    expect(selected).not.toContain('Pick a plan')
    expect(render('')).toContain('Pick a plan')
    // 不传 valueLabel 时 Radix 只在客户端填入文字：SSR 输出里没有选中项
    const without = renderToString(
      <Select value="pro">
        <SelectTrigger placeholder="Pick a plan" aria-label="Plan" />
        <SelectContent>
          <SelectItem index={0} value="pro">
            Pro
          </SelectItem>
        </SelectContent>
      </Select>,
    )
    expect(without).not.toContain('Pro')
  })

  it('键盘打开并选择选项，onValueChange 收到取值且触发器显示所选文字', async () => {
    const onValueChange = vi.fn()
    render(
      <Select onValueChange={onValueChange}>
        <SelectTrigger placeholder="Pick a plan" aria-label="Plan" />
        <SelectContent>
          <SelectItem index={0} value="free">
            Free
          </SelectItem>
          <SelectItem index={1} value="pro">
            Pro
          </SelectItem>
        </SelectContent>
      </Select>,
    )
    const trigger = screen.getByRole('combobox', { name: 'Plan' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    const option = await screen.findByRole('option', { name: 'Pro' })
    fireEvent.keyDown(option, { key: 'Enter' })
    expect(onValueChange).toHaveBeenCalledWith('pro')
    await act(() => new Promise((resolve) => setTimeout(resolve, 600)))
    expect(trigger.textContent).toContain('Pro')
  })
})
