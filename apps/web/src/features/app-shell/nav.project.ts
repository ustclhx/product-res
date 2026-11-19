// 项目自有：模板只创建本文件，之后不再修改（template-release 检查），template-sync 不会在这里冲突。
// 在 registerProjectAppNav 里登记项目自己的侧边栏条目，或替换 / 移除模板条目（id 相同即覆盖），例如：
//
//   import { Folder } from '@product-res/ui/icons'
//   import { m } from '../../paraglide/messages.js'
//   import { registerAppNav, unregisterAppNav } from './nav.ts'
//
//   registerAppNav({
//     group: 'content',
//     items: [{ id: 'reports', label: m.reports_title, icon: Folder, to: '/app/$slug/reports' }],
//   })
//   unregisterAppNav('media-tasks')
//
// 分组固定为 tools / content / settings；可见性用 visible({ role, readOnly, isPersonal })；
// to 必须是 /app/$slug 下已存在的路由。顶部布局（ui.appLayout: 'topbar'）也会渲染这里新增的条目。
export function registerProjectAppNav() {}
