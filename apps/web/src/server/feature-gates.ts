import { AppError } from '@product-res/shared'
import { createMiddleware } from '@tanstack/react-start'
import { templateConfig } from './template-config.ts'

export function requireFeature(feature: 'billing' | 'credits') {
  if (!templateConfig[feature].enabled)
    throw new AppError('NOT_FOUND', 'Not Found', { status: 404 })
}

export const withBilling = createMiddleware({ type: 'function' }).server(({ next }) => {
  requireFeature('billing')
  return next()
})
export const withCredits = createMiddleware({ type: 'function' }).server(({ next }) => {
  requireFeature('credits')
  return next()
})
