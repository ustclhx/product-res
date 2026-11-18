import { createFileRoute } from '@tanstack/react-router'
import { getSharePage } from '../features/share-cards/page.functions.ts'
import { SharePage, SharePageGone } from '../features/share-cards/share-page.tsx'
import { templateConfig } from '../server/template-config.ts'

const noindex = { name: 'robots', content: 'noindex' }

/** 通用分享页（openspec add-og-images design 第 8 条）；不预渲染、不进站点地图与 llms.txt。 */
export const Route = createFileRoute('/s/$type/$token')({
  server: {
    handlers: {
      // 渲染前完成查找与限流；分享模块按需加载，不进入客户端包。
      GET: async ({ request, params, next }) =>
        (await import('../features/share-cards/page.server.ts')).handleSharePageRequest({
          request,
          params,
          next,
        }),
    },
  },
  loader: ({ params }) => getSharePage({ data: { type: params.type, token: params.token } }),
  head: ({ loaderData }) =>
    loaderData?.status === 'ok'
      ? {
          meta: [{ title: `${loaderData.title} | ${templateConfig.app.name}` }, ...loaderData.meta],
        }
      : { meta: [noindex] },
  component: SharePageRoute,
  notFoundComponent: ({ data }) => (
    <SharePageGone
      reason={
        (data as { reason?: string } | undefined)?.reason === 'expired' ? 'expired' : 'not-found'
      }
    />
  ),
})

function SharePageRoute() {
  const view = Route.useLoaderData()
  if (!view) return null
  return view.status === 'ok' ? <SharePage view={view} /> : <SharePageGone reason={view.status} />
}
