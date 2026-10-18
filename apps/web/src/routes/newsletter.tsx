import { createFileRoute, notFound } from '@tanstack/react-router'
import { GrowthForm } from '../features/growth/forms.tsx'
import { originFromMatches, pageHead, staticPage } from '../features/seo/metadata.ts'
import { getLocale } from '../paraglide/runtime.js'
import { templateConfig } from '../server/template-config.ts'
export const Route = createFileRoute('/newsletter')({
  beforeLoad: () => {
    if (!templateConfig.features.newsletter) throw notFound()
  },
  head: ({ matches }) =>
    pageHead(staticPage('/newsletter', getLocale()), originFromMatches(matches)),
  component: () => <GrowthForm feature="newsletter" />,
})
