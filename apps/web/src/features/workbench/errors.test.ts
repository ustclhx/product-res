import { AppError } from '@product-res/shared'
import { expect, it } from 'vitest'
import { m } from '../../paraglide/messages.js'
import { workbenchErrorText } from './errors.ts'
import { workspaceTransferErrorAdapter } from './transfer-error.ts'

it('按流转错误码显示本地化文案，其它错误保留原消息', () => {
  expect(workbenchErrorText(new AppError('WORKSPACE_TRANSFERRING', 'server message'))).toBe(
    m.workbench_error_workspace_transferring(),
  )
  expect(workbenchErrorText({ code: 'WORKSPACE_TRANSFERRING' })).toBe(
    m.workbench_error_workspace_transferring(),
  )
  expect(workbenchErrorText(new Error('原消息'))).toBe('原消息')
})

it('RPC 往返保留流转错误码用于文案映射，不序列化内部详情，也不接管其它错误', () => {
  const original = new AppError('WORKSPACE_TRANSFERRING', 'server message', {
    status: 403,
    details: { private: 'internal' },
  })
  expect(workspaceTransferErrorAdapter.test(original)).toBe(true)
  const wire = JSON.stringify(workspaceTransferErrorAdapter.toSerializable(original))
  expect(wire).not.toContain('internal')
  const decoded = workspaceTransferErrorAdapter.fromSerializable(JSON.parse(wire))
  expect(decoded).toMatchObject({ code: 'WORKSPACE_TRANSFERRING', status: 403 })
  expect(workbenchErrorText(decoded)).toBe(m.workbench_error_workspace_transferring())
  expect(workspaceTransferErrorAdapter.test(new AppError('WORKSPACE_READ_ONLY', 'read only'))).toBe(
    false,
  )
})
