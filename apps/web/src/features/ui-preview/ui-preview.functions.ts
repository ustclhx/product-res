import { createServerFn } from '@tanstack/react-start'
import { getWebRuntime } from '../../server/runtime.ts'
import { isUiPreviewEnabled } from './gate.ts'

/** 在服务端读取 `UI_PREVIEW`；只返回布尔值，被直接调用也不泄露配置 */
export const getUiPreviewEnabled = createServerFn({ method: 'GET' }).handler(() =>
  isUiPreviewEnabled(getWebRuntime().config),
)
