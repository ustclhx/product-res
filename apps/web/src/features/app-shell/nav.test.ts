import { afterEach, describe, expect, it } from 'vitest'
import {
  type AppNavContext,
  type AppNavItem,
  activeAppNavId,
  appNavHref,
  registerAppNav,
  resetAppNav,
  resolveAppNav,
  unregisterAppNav,
} from './nav.ts'

const Icon = () => null
const owner: AppNavContext = { role: 'owner', readOnly: false, isPersonal: true }
const member: AppNavContext = { role: 'member', readOnly: false, isPersonal: false }

function item(id: string, to: AppNavItem['to'], extra: Partial<AppNavItem> = {}): AppNavItem {
  return { id, label: () => id, icon: Icon, to, ...extra }
}

const ids = (context = owner) =>
  resolveAppNav(context).map((group) => [group.id, group.items.map((entry) => entry.id)])

afterEach(() => resetAppNav())

describe('registerAppNav', () => {
  it('项目注册「工具」分组及两个条目后按分组返回', () => {
    registerAppNav({
      group: 'tools',
      items: [item('chat', '/app/$slug/chat'), item('media', '/app/$slug/media/new')],
    })
    expect(ids()).toEqual([['tools', ['chat', 'media']]])
  })

  it('分组按 工具 / 内容 / 设置 固定顺序，与注册先后无关；空分组不返回', () => {
    registerAppNav({ group: 'settings', items: [item('billing', '/app/$slug/billing')] })
    registerAppNav({ group: 'tools', items: [item('chat', '/app/$slug/chat')] })
    expect(ids()).toEqual([
      ['tools', ['chat']],
      ['settings', ['billing']],
    ])
  })

  it('组内按 order 排序，相同时按注册先后', () => {
    registerAppNav({
      group: 'tools',
      items: [
        item('b', '/app/$slug/billing'),
        item('a', '/app/$slug/api-keys', { order: 5 }),
        item('c', '/app/$slug/chat'),
      ],
    })
    expect(ids()).toEqual([['tools', ['a', 'b', 'c']]])
  })

  it('同 id 再次注册覆盖原条目并保留原位置；unregisterAppNav 移除条目', () => {
    registerAppNav({
      group: 'tools',
      items: [item('home', '/app/$slug'), item('chat', '/app/$slug/chat')],
    })
    registerAppNav({ group: 'tools', items: [item('home', '/app/$slug', { label: () => '首页' })] })
    const [tools] = resolveAppNav(owner)
    expect(tools?.items.map((entry) => entry.label())).toEqual(['首页', 'chat'])
    unregisterAppNav('chat')
    expect(ids()).toEqual([['tools', ['home']]])
  })

  it('按角色与空间状态过滤不可见条目', () => {
    registerAppNav({
      group: 'settings',
      items: [
        item('keys', '/app/$slug/api-keys', {
          visible: ({ role }) => role === 'owner' || role === 'admin',
        }),
        item('members', '/app/$slug/settings', { visible: ({ isPersonal }) => !isPersonal }),
        item('usage', '/app/$slug/usage'),
      ],
    })
    expect(ids(owner)).toEqual([['settings', ['keys', 'usage']]])
    expect(ids(member)).toEqual([['settings', ['members', 'usage']]])
  })
})

describe('当前项高亮', () => {
  function groups() {
    registerAppNav({
      group: 'tools',
      items: [
        item('home', '/app/$slug', { exact: true }),
        item('chat', '/app/$slug/chat'),
        item('media', '/app/$slug/media/new'),
      ],
    })
    registerAppNav({ group: 'content', items: [item('tasks', '/app/$slug/tasks')] })
    return resolveAppNav(owner)
  }

  it('路径相同或位于条目之下时高亮该条目', () => {
    const nav = groups()
    expect(activeAppNavId(nav, '/app/acme/chat', 'acme')).toBe('chat')
    expect(activeAppNavId(nav, '/app/acme/chat/0193-uuid', 'acme')).toBe('chat')
    expect(activeAppNavId(nav, '/app/acme/tasks/', 'acme')).toBe('tasks')
  })

  it('exact 条目只在完全相同时高亮，前缀相同的其他路径不算', () => {
    const nav = groups()
    expect(activeAppNavId(nav, '/app/acme', 'acme')).toBe('home')
    expect(activeAppNavId(nav, '/app/acme/', 'acme')).toBe('home')
    expect(activeAppNavId(nav, '/app/acme/billing', 'acme')).toBeNull()
    expect(activeAppNavId(nav, '/app/acme/chatroom', 'acme')).toBeNull()
  })

  it('多个条目匹配时取路径最长的', () => {
    registerAppNav({
      group: 'tools',
      items: [item('chat', '/app/$slug/chat'), item('context', '/app/$slug/chat/context')],
    })
    expect(activeAppNavId(resolveAppNav(owner), '/app/acme/chat/context', 'acme')).toBe('context')
    expect(activeAppNavId(resolveAppNav(owner), '/app/acme/chat/123', 'acme')).toBe('chat')
  })

  it('slug 编码后填入路径', () => {
    expect(appNavHref({ to: '/app/$slug/chat' }, 'a b')).toBe('/app/a%20b/chat')
  })
})
