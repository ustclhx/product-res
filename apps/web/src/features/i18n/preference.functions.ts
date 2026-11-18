import { AppError } from '@product-res/shared'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { isLocale } from '../../paraglide/runtime.js'
import { getWebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { readRequestSession } from './session.server.ts'

/** 手动选择也应用于已登录账号；没有有效会话时只由浏览器记 Cookie。 */
export const saveLanguagePreference = createServerFn({ method: 'POST' })
  .validator((locale: unknown) => {
    if (!templateConfig.i18n.enabled) throw new AppError('NOT_FOUND', 'Not found', { status: 404 })
    if (!isLocale(locale)) throw new TypeError('Unsupported locale')
    return locale
  })
  .handler(async ({ data }) => {
    const { db, auth } = getWebRuntime()
    let signedIn = false
    try {
      await readRequestSession({ auth, db, headers: getRequest().headers })
      signedIn = true
    } catch (error) {
      if (!(error instanceof AppError && [401, 403].includes(error.status))) throw error
    }
    if (signedIn)
      await auth.api.updateUser({ headers: getRequest().headers, body: { locale: data } })
    return { ok: true }
  })
