// 模板新增（tasks 4.2 审阅）：全局单键快捷键的共用判定，Command Menu 与 Sidebar 共用。

/** 焦点在可输入元素上：单键快捷键让给输入 */
export function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable === true
  )
}

/** 焦点在菜单、列表框或对话框内：方括号等单键属于该组件（如 typeahead），不触发页面级快捷键 */
export function isInsidePopup(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return Boolean(
    el?.closest?.('[role="menu"],[role="listbox"],[role="dialog"],[role="alertdialog"]'),
  )
}
