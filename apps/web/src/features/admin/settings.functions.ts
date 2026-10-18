import { log } from '@product-res/shared/log'
import { createServerFn } from '@tanstack/react-start'
import { getWebRuntime } from '../../server/runtime.ts'
import { withAdminAction } from './action.server.ts'
import { adminMiddleware } from './admin.functions.ts'
import { invalidateRuntimeSettings, readRuntimeSettings, writeRuntimeSettings } from './settings.ts'
import { runtimeSettingsInput } from './settings-schema.ts'

export const getAdminSettings = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(({ context }) => readRuntimeSettings(context.db))

export const saveAdminSettings = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator(runtimeSettingsInput)
  .handler(async ({ context, data }) => {
    await withAdminAction(context, 'setting.update', (scope) => writeRuntimeSettings(scope, data))
    try {
      await invalidateRuntimeSettings(getWebRuntime().cache)
    } catch (error) {
      log.error('admin.settings_cache_invalidation_failed', {
        error,
        actorUserId: context.admin.id,
      })
      return {
        ok: false,
        error:
          'Settings were saved, but cache refresh failed. They will apply within about 60 seconds. Reload before editing again.',
      }
    }
    log.info('admin.settings_updated', { actorUserId: context.admin.id })
    return { ok: true }
  })
