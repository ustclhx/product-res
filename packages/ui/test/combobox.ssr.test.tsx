// @vitest-environment node
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  Combobox,
  ComboboxChips,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '../src/components/combobox.tsx'

const list = (
  <ComboboxContent>
    <ComboboxEmpty>没有匹配项</ComboboxEmpty>
    <ComboboxList>
      {(item) => <ComboboxItem value={item as string}>{item as string}</ComboboxItem>}
    </ComboboxList>
  </ComboboxContent>
)

// TanStack Start 服务端渲染：不依赖浏览器 API，输出收起状态的输入框，弹层不渲染
describe('Combobox SSR', () => {
  it('单选与多选字段输出 role="combobox" 的输入框和已选标签', () => {
    const html = renderToString(
      <>
        <Combobox items={['苹果', '香蕉']} defaultValue="苹果" name="fruit">
          <ComboboxInput placeholder="搜索水果" aria-label="水果" clearable clearLabel="清除" />
          {list}
        </Combobox>
        <Combobox items={['苹果', '香蕉']} multiple defaultValue={['香蕉']}>
          <ComboboxChips
            placeholder="添加水果"
            aria-label="多个水果"
            chipsLabel="已选水果"
            removeLabel={(label) => `移除 ${label}`}
          />
          {list}
        </Combobox>
      </>,
    )
    expect(html).toMatch(/<input[^>]*role="combobox"[^>]*aria-expanded="false"/)
    expect(html).toContain('value="苹果"')
    expect(html).toContain('aria-label="清除"')
    expect(html).toContain('aria-label="已选水果"')
    expect(html).toContain('aria-label="移除 香蕉"')
    expect(html).not.toContain('role="listbox"')
  })
})
