import { m } from '../../paraglide/messages.js'
import { type WorkspacePage, WorkspaceSwitcher } from '../workspace/components.tsx'

/**
 * 工作台首页（侧边栏布局）：问候、角色与多空间切换。原顶部布局头部的这些信息移到这里；
 * 最近对话、积分余额等首页区块属于后续需求，不在本页实现。顶部布局不渲染本组件。
 */
export function WorkspaceOverview({ page }: { page: WorkspacePage }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        {/* 页面 h1 是工作台顶部条的标题 */}
        <h2 className="font-semibold text-display">
          {m.app_shell_welcome({ name: page.user.name || page.user.email })}
        </h2>
        <p className="text-muted-foreground">{m.app_shell_welcome_desc()}</p>
        <p className="text-caption text-muted-foreground">{m.app_role({ role: page.role })}</p>
      </div>
      {page.multiTenant ? (
        <div className="max-w-md">
          <WorkspaceSwitcher page={page} />
        </div>
      ) : null}
    </div>
  )
}
