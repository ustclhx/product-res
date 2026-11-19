import { useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'
import { templateConfig } from '../../server/template-config.ts'
import { startPostHog } from './client.ts'
import { ensureFirstTouch, startClarity, trackEvent } from './track.ts'

export function ProductAnalytics() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  useEffect(() => {
    if (templateConfig.features.analytics !== 'posthog' || /^\/(admin|api)(\/|$)/.test(pathname))
      return
    return startPostHog(templateConfig)
  }, [pathname])
  useEffect(() => {
    // 先写首触再发事件，首个 page_view 就能带上来源。
    ensureFirstTouch()
    trackEvent('page_view')
    startClarity(pathname)
  }, [pathname])
  return null
}
