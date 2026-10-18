import { useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'
import { templateConfig } from '../../server/template-config.ts'
import { startPostHog } from './client.ts'

export function ProductAnalytics() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  useEffect(() => {
    if (templateConfig.features.analytics !== 'posthog' || /^\/(admin|api)(\/|$)/.test(pathname))
      return
    return startPostHog(templateConfig)
  }, [pathname])
  return null
}
