import type { Database } from '@product-res/db'

/** 工作台 service 的调用方：数据库、空间与写权限所需的成员信息（由 withWorkspace 的 context 转换） */
export interface WorkbenchActor {
  db: Database
  workspaceId: string
  workspaceReadOnly: boolean
  member: { role: string }
}

export function actorOf(context: {
  db: Database
  workspace: { id: string }
  workspaceReadOnly: boolean
  member: { role: string }
}): WorkbenchActor {
  return {
    db: context.db,
    workspaceId: context.workspace.id,
    workspaceReadOnly: context.workspaceReadOnly,
    member: { role: context.member.role },
  }
}
