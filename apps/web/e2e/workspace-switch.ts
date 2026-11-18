import { expect, type Page } from '@playwright/test'

/**
 * 经工作台侧边栏的工作区菜单切换空间（ui.appLayout: 'sidebar'，多空间时出现）。
 * option 为菜单项名称：团队空间是空间名，个人空间是「空间名 · 个人空间文案」。
 * 页面刚整页刷新时按钮可能尚未水合，点击无效，因此重试到菜单出现为止。
 */
export async function switchWorkspace(page: Page, option: string) {
  const trigger = page.getByRole('button', {
    name: /^(Change workspace, current:|切换工作区，当前：)/,
  })
  const item = page.getByRole('menuitemradio', { name: option, exact: true })
  await expect(async () => {
    if (!(await item.isVisible())) await trigger.click()
    await expect(item).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
  await item.click()
}
