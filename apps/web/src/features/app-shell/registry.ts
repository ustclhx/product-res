// 导航注册入口：先清空，再登记模板条目，最后登记项目条目（同 id 覆盖模板条目）。
// 每次模块（含热更新）执行都从空注册表开始，不残留旧条目。布局只导入本文件。
import { registerDefaultAppNav } from './nav.default.ts'
import { registerProjectAppNav } from './nav.project.ts'
import { resetAppNav } from './nav.ts'

resetAppNav()
registerDefaultAppNav()
registerProjectAppNav()

export { TEMPLATE_NAV_IDS } from './nav.default.ts'
export { activeAppNavId, resolveAppNav } from './nav.ts'
