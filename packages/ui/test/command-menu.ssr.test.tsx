// @vitest-environment node
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  CommandMenu,
  CommandMenuDialog,
  CommandMenuFooter,
  CommandMenuInput,
  CommandMenuList,
  CommandMenuPlatform,
  CommandMenuTabs,
} from '../src/components/command-menu.tsx'
import { Tabs, TabsItem } from '../src/components/tabs.tsx'

const labels = {
  placeholder: '搜索命令',
  suggestions: '建议',
  tabs: '筛选结果',
  selectHint: '选择',
  tabsHint: '切换',
  closeHint: '关闭',
}

// TanStack Start 在服务端渲染：组件不得在渲染期访问 window / navigator / 布局 API
describe('SSR：Tabs 与 CommandMenu', () => {
  it('Tabs 输出 tablist 与选中标签', () => {
    const html = renderToString(
      <Tabs aria-label="分区" selectedIndex={1} onSelect={() => {}}>
        <TabsItem index={0} label="一" />
        <TabsItem index={1} label="二" />
      </Tabs>,
    )
    expect(html).toContain('role="tablist"')
    expect(html).toContain('aria-label="分区"')
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"/)
  })

  it('CommandMenu 输出搜索框、行与按平台绘制的键帽；关闭的对话框不输出内容', () => {
    const html = renderToString(
      <CommandMenuPlatform mac={false}>
        <CommandMenu items={[{ value: 'new', label: '新建', shortcut: 'mod+n' }]} labels={labels}>
          <CommandMenuInput />
          <CommandMenuTabs
            tabs={[{ value: 'all', label: '全部' }]}
            value="all"
            onValueChange={() => {}}
          />
          <CommandMenuList />
          <CommandMenuFooter />
        </CommandMenu>
        <CommandMenuDialog title="命令面板">
          <CommandMenu items={[]} labels={labels}>
            <CommandMenuInput />
          </CommandMenu>
        </CommandMenuDialog>
      </CommandMenuPlatform>,
    )
    expect(html).toContain('role="combobox"')
    expect(html).toContain('placeholder="搜索命令"')
    expect(html).toContain('role="option"')
    expect(html).toContain('>Ctrl<')
    expect(html).toContain('aria-label="筛选结果"')
    expect(html).not.toContain('命令面板')
  })
})
