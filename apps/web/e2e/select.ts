import { expect, type Locator } from '@playwright/test'

/**
 * 在 `@product-res/ui` 的 Select 中选择一项（替代原生 `<select>` 的 `selectOption`）。
 *
 * - `trigger` 用可访问名称定位：`form.getByRole('combobox', { name: 'Pricing mode', exact: true })`
 * - `option` 传选项文字（可访问名称），动态文案可用正则；返回选中项的 `data-value`。
 *   数据驱动的验收脚本只有取值时传 `{ value }`，按 SelectItem 的
 *   `data-value` 匹配（「默认」等空值传页面导出的占位值常量）
 *
 * 水合前点击无效，函数会重试点击直到列表展开（触发器 `aria-expanded="true"`），再在本选择框的列表
 * （`aria-controls`）里点选。选中后弹层有约 300ms 的确认动画，期间 Radix 屏蔽页面其余指针事件，
 * 所以等列表移除后再返回。
 */
export async function chooseOption(trigger: Locator, option: string | RegExp | { value: string }) {
  const page = trigger.page()
  // 展开后 Radix 给页面其余部分加 aria-hidden，按角色定位的 trigger 就匹配不到了：先固定到元素本身
  const handle = await trigger.elementHandle()
  if (!handle) throw new Error('Select trigger not found')
  try {
    await expect(async () => {
      if ((await handle.getAttribute('aria-expanded')) !== 'true') await handle.click()
      expect(await handle.getAttribute('aria-expanded')).toBe('true')
    }).toPass({ intervals: [100, 250, 500, 1_000] })
    const listboxId = await handle.getAttribute('aria-controls')
    if (!listboxId) throw new Error('Select trigger has no aria-controls listbox')
    const listbox = page.locator(`[id=${JSON.stringify(listboxId)}]`)
    const item =
      typeof option === 'string' || option instanceof RegExp
        ? listbox.getByRole('option', { name: option, exact: true })
        : listbox.locator(`[role="option"][data-value=${JSON.stringify(option.value)}]`)
    const value = await item.getAttribute('data-value')
    await item.click()
    await expect(listbox).toHaveCount(0)
    return value
  } finally {
    await handle.dispose()
  }
}
