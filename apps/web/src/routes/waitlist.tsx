import { createFileRoute, notFound } from '@tanstack/react-router'
import { GrowthForm } from '../features/growth/forms.tsx'
import { originFromMatches, pageHead, staticPage } from '../features/seo/metadata.ts'
import { getLocale } from '../paraglide/runtime.js'
import { templateConfig } from '../server/template-config.ts'
export const Route = createFileRoute('/waitlist')({
  beforeLoad: () => {
    if (!templateConfig.features.waitlist) throw notFound()
  },
  head: ({ matches }) => pageHead(staticPage('/waitlist', getLocale()), originFromMatches(matches)),
  component: () => <GrowthForm feature="waitlist" />,
})
