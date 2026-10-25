import { m } from '../../paraglide/messages.js'

/** 工作台与数据中心共享稳定错误码文案。 */
export function workbenchErrorText(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'WORKSPACE_TRANSFERRING'
  )
    return m.workbench_error_workspace_transferring()
  return error instanceof Error && error.message ? error.message : '操作失败，请重试'
}
