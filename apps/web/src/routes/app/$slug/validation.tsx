import { createFileRoute } from '@tanstack/react-router'
import { getValidationPage } from '../../../features/validation/validation.functions.ts'
import { ValidationPage } from '../../../features/validation/validation-page.tsx'

export const Route = createFileRoute('/app/$slug/validation')({
  head: () => ({ meta: [{ title: '算法验证' }] }),
  loader: ({ params }) => getValidationPage({ data: { slug: params.slug } }),
  staleTime: 0,
  component: ValidationRoute,
})

function ValidationRoute() {
  const { slug } = Route.useParams()
  return (
    <ValidationPage
      slug={slug}
      initial={Route.useLoaderData()}
      reload={() => getValidationPage({ data: { slug } })}
    />
  )
}
