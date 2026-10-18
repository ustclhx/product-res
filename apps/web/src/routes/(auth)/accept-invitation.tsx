import { Button } from '@product-res/ui'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { authClient } from '../../features/auth/auth-client.ts'
import {
  AuthLayout,
  authLinkClassName,
  FormAlert,
  StatusAlert,
} from '../../features/auth/auth-layout.tsx'
import { authErrorMessage } from '../../features/auth/errors.ts'
import {
  actionResult,
  activateWorkspace,
  workspaceAction,
  workspaceError,
} from '../../features/workspace/client.ts'
import { getInvitationPage } from '../../features/workspace/workspace.functions.ts'
import { m } from '../../paraglide/messages.js'

export const Route = createFileRoute('/(auth)/accept-invitation')({
  validateSearch: z.object({ id: z.uuid() }),
  beforeLoad: async ({ search }) => ({ invitationPage: await getInvitationPage({ data: search }) }),
  loaderDeps: ({ search }) => search,
  loader: ({ context }) => context.invitationPage,
  staleTime: 0,
  component: InvitationPage,
})
function InvitationPage() {
  const page = Route.useLoaderData()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [sent, setSent] = useState(false)
  return (
    <AuthLayout
      title={m.auth_accept_invitation()}
      footer={
        <a href="/app" className={authLinkClassName}>
          {m.auth_go_to_my_workspace()}
        </a>
      }
    >
      <FormAlert message={error} />
      {'error' in page ? (
        <FormAlert message={workspaceError(page.error)} />
      ) : page.verifyRequired === true ? (
        <>
          <p>{m.auth_verify_before_viewing_and_accepting_this_invitation({ email: page.email })}</p>
          {sent ? (
            <StatusAlert>{m.auth_verification_email_sent_check_your_inbox_and_open()}</StatusAlert>
          ) : null}
          <Button
            disabled={pending}
            onClick={async () => {
              setPending(true)
              setError(null)
              try {
                const result = await authClient().sendVerificationEmail({
                  email: page.email,
                  callbackURL: `/accept-invitation?id=${page.id}`,
                })
                if (result.error) setError(authErrorMessage(result.error))
                else setSent(true)
              } catch {
                setError(m.auth_could_not_send_verification_email_please_try_again())
              } finally {
                setPending(false)
              }
            }}
          >
            {m.auth_send_verification_email()}
          </Button>
          <p>{m.auth_open_the_link_to_return_here_if_you()} </p>
          <Button variant="outline" onClick={() => window.location.reload()}>
            {m.auth_reload_after_verification()}
          </Button>
          {!page.multiTenant ? (
            <p>{m.auth_team_features_are_disabled_invitations_cannot_be_accepted()}</p>
          ) : null}
        </>
      ) : (
        <>
          <p>
            {m.auth_you_are_invited_to_as({
              workspace: String(page.workspace.name),
              role: String(page.invitation.role),
            })}
          </p>
          {page.multiTenant ? (
            <Button
              disabled={pending}
              onClick={async () => {
                setPending(true)
                setError(null)
                try {
                  await workspaceAction(
                    'accept-invitation',
                    { invitationId: page.invitation.id },
                    actionResult,
                  )
                  await activateWorkspace(page.workspace)
                } catch (e) {
                  setError(e instanceof Error ? e.message : m.auth_could_not_accept_invitation())
                  setPending(false)
                }
              }}
            >
              {m.auth_accept_invitation()}
            </Button>
          ) : (
            <p>{m.auth_team_features_are_disabled_invitations_cannot_be_accepted()}</p>
          )}
        </>
      )}
    </AuthLayout>
  )
}
