import { createServerFn } from '@tanstack/react-start'
import { getWebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { authUiOptions } from './options.ts'

/** 认证页面的 loader：在服务端读取模板配置与 env，只返回公开的部分 */
export const getAuthUiOptions = createServerFn({ method: 'GET' }).handler(() =>
  authUiOptions(templateConfig, getWebRuntime().config),
)
