import { Button, buttonVariants } from '@product-res/ui'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useState } from 'react'
import { AuthLayout, authLinkClassName, FormAlert } from '../../features/auth/auth-layout.tsx'
import { activateWorkspace } from '../../features/workspace/client.ts'
import { joinWithLinkFn, previewJoinFn } from '../../features/workspace/invite-links.functions.ts'
import {
  inviteLinkErrorMessage,
  joinStatusMessage,
  roleLabel,
} from '../../features/workspace/labels.ts'
import { m } from '../../paraglide/messages.js'

/**
 * 邀请链接加入页（add-team-invite-links 4.3）。token 在路径中：请求日志、Sentry 与页面统计
 * 都对 `/join/` 脱敏或排除，页面不向外发送 Referer；预览与加入经 POST 请求体传递 token。
 */
export const Route = createFileRoute('/(auth)/join/$token')({
  loader: async ({ params }) => {
    const preview = await previewJoinFn({ data: { token: params.token } })
    // 已是成员：直接进入该空间，不消耗次数
    if (preview.status === 'member')
      throw redirect({ to: '/app/$slug', params: { slug: preview.workspace.slug } })
    return preview
  },
  staleTime: 0,
  head: () => ({
    meta: [
      { title: m.join_title() },
      { name: 'referrer', content: 'no-referrer' },
      { name: 'robots', content: 'noindex' },
    ],
  }),
  component: JoinPage,
})

function JoinPage() {
  const preview = Route.useLoaderData()
  const { token } = Route.useParams()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const back = `?redirect=${encodeURIComponent(`/join/${token}`)}`
  return (
    <AuthLayout
      title={m.join_title()}
      footer={
        preview.status === 'signed_out' ? null : (
          <a href="/app" className={authLinkClassName}>
            {m.join_go_workspace()}
          </a>
        )
      }
    >
      {preview.status === 'signed_out' ? (
        <>
          <p className="text-sm">{m.join_signed_out()}</p>
          <div className="grid gap-2">
            <a href={`/login${back}`} className={buttonVariants()}>
              {m.join_sign_in()}
            </a>
            <a href={`/register${back}`} className={buttonVariants({ variant: 'outline' })}>
              {m.join_register()}
            </a>
          </div>
        </>
      ) : preview.status === 'valid' ? (
        <>
          <p className="font-medium text-base">
            {m.join_prompt({
              workspace: preview.workspace.name,
              role: roleLabel(preview.role),
            })}
          </p>
          <p className="text-muted-foreground text-sm">{m.join_prompt_hint()}</p>
          <FormAlert message={error} />
          <Button
            disabled={pending}
            onClick={async () => {
              setPending(true)
              setError(null)
              try {
                const result = await joinWithLinkFn({ data: { token } })
                if ('error' in result) {
                  setError(inviteLinkErrorMessage(result.error))
                  setPending(false)
                  return
                }
                await activateWorkspace(result.workspace)
              } catch {
                setError(m.join_error_unknown())
                setPending(false)
              }
            }}
          >
            {pending ? m.join_joining() : m.join_confirm()}
          </Button>
        </>
      ) : (
        <FormAlert message={joinStatusMessage(preview.status)} />
      )}
    </AuthLayout>
  )
}
