import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AppShellBar, AppShellBarContext, useAppShellBarAvailable } from './bar.tsx'

function Probe() {
  return <span>{useAppShellBarAvailable() ? 'shell' : 'none'}</span>
}

describe('AppShellBar', () => {
  it('不在工作台壳中（顶部布局）时不渲染，页面据此自行渲染工具条', () => {
    const html = renderToStaticMarkup(
      <>
        <Probe />
        <AppShellBar title="章节" actions={<button type="button">导出</button>} />
      </>,
    )
    expect(html).toBe('<span>none</span>')
  })

  it('服务端首屏插槽尚未挂载时不输出内容，壳显示默认标题', () => {
    const slots = { title: null, actions: null, progress: null }
    const html = renderToStaticMarkup(
      <AppShellBarContext.Provider value={slots}>
        <Probe />
        <AppShellBar title="章节" progress={<div role="progressbar" />} />
      </AppShellBarContext.Provider>,
    )
    expect(html).toBe('<span>shell</span>')
  })
})
