import { Button, cn, Input, Label, Tag, useAppForm } from '@product-res/ui'
import { type ReactNode, useEffect, useState } from 'react'
import { z } from 'zod'
import { m } from '../../paraglide/messages.js'
import { FormAlert } from '../auth/auth-layout.tsx'
import { Section } from '../data-center/shared.tsx'
import { actionResult, activateWorkspace, workspaceAction } from './client.ts'
import { InviteLinksPanel, type InviteLinksState } from './invite-links-panel.tsx'
import { roleLabel } from './labels.ts'
import type { getWorkspacePage } from './workspace.functions.ts'

export type WorkspacePage = Extract<
  Awaited<ReturnType<typeof getWorkspacePage>>,
  { activation: 'active' }
>
export function HydratedControls({ children }: { children: ReactNode }) {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])
  return (
    <fieldset disabled={!hydrated} className="grid min-w-0 gap-4">
      {children}
    </fieldset>
  )
}

/** 顶栏的空间菜单：切换空间 + 创建团队空间；多租户关闭时不渲染 */
export function WorkspaceSwitcher({ page }: { page: WorkspacePage }) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  if (!page.multiTenant) return null
  return (
    <details className="relative" data-testid="workspace-menu">
      <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md border px-2.5 py-1 text-[13px] hover:bg-accent">
        {m.workspace_menu()}
        <span aria-hidden="true" className="text-muted-foreground text-xs">
          ▾
        </span>
      </summary>
      <div className="absolute right-0 z-30 mt-2 grid w-80 gap-3 rounded-lg border bg-popover p-3 text-sm shadow-md">
        <HydratedControls>
          <p className="text-muted-foreground text-xs">{m.workspace_menu_heading()}</p>
          <ul className="grid gap-1" aria-label={m.workspace_menu_heading()}>
            {page.spaces.map((space) => {
              const current = space.id === page.workspace.id
              return (
                <li key={space.id}>
                  <button
                    type="button"
                    disabled={pending || current}
                    aria-current={current ? 'true' : undefined}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent disabled:cursor-default',
                      current && 'bg-primary-soft text-primary hover:bg-primary-soft',
                    )}
                    onClick={async () => {
                      setPending(true)
                      setError(null)
                      try {
                        await activateWorkspace(space)
                      } catch {
                        setError(m.workspace_switch_failed())
                        setPending(false)
                      }
                    }}
                  >
                    <span className="truncate">{space.name}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {current ? <span className="text-xs">{m.workspace_current()}</span> : null}
                      <Tag tone={space.isPersonal ? 'neutral' : 'info'}>
                        {space.isPersonal ? m.workspace_kind_personal() : m.workspace_kind_team()}
                      </Tag>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          <FormAlert message={error} />
          <div className="border-t pt-3">
            <CreateTeam />
          </div>
        </HydratedControls>
      </div>
    </details>
  )
}

function CreateTeam() {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const form = useAppForm({
    defaultValues: { name: '', slug: '' },
    validators: {
      onSubmit: z.object({
        name: z.string().trim().min(1).max(100),
        slug: z
          .string()
          .min(3)
          .max(64)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(null)
      try {
        const team = await workspaceAction(
          'create',
          value,
          z.object({ id: z.string(), slug: z.string() }),
        )
        await activateWorkspace(team)
      } catch (e) {
        setError(e instanceof Error ? e.message : m.workspace_create_failed())
      }
    },
  })
  if (!open)
    return (
      <Button variant="outline" size="sm" className="w-full" onClick={() => setOpen(true)}>
        {m.workspace_create_team()}
      </Button>
    )
  return (
    <form.AppForm>
      <form.Form aria-label={m.workspace_create_team()}>
        <p className="text-muted-foreground text-xs">{m.workspace_create_team_hint()}</p>
        <FormAlert message={error} />
        <form.AppField name="name">
          {(field) => <field.TextField label={m.workspace_team_name()} />}
        </form.AppField>
        <form.AppField name="slug">
          {(field) => (
            <field.TextField
              label={m.workspace_team_slug()}
              description={m.workspace_team_slug_hint()}
            />
          )}
        </form.AppField>
        <form.SubmitButton pendingLabel={m.workspace_creating()}>
          {m.workspace_create_submit()}
        </form.SubmitButton>
      </form.Form>
    </form.AppForm>
  )
}

const selectClass = 'h-8 rounded-md border bg-background px-2 text-[13px]'

export function WorkspaceSettings({
  page,
  inviteLinks,
}: {
  page: WorkspacePage
  inviteLinks: InviteLinksState
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('member')
  const seatsFull = page.maxSeats !== null && page.memberCount >= page.maxSeats
  async function run(action: string, body: object) {
    setPending(true)
    setError(null)
    try {
      await workspaceAction(action, { organizationId: page.workspace.id, ...body }, actionResult)
      window.location.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : m.workspace_update_failed())
      setPending(false)
    }
  }
  return (
    <div className="grid max-w-4xl gap-4">
      <h1 className="font-semibold text-lg">{m.workspace_settings_title()}</h1>
      {page.workspace.isPersonal ? (
        <p className="text-muted-foreground text-sm">{m.workspace_settings_personal_hint()}</p>
      ) : null}
      {page.readOnly ? (
        <p role="status" className="text-sm text-warning-strong">
          {m.workspace_read_only()}
        </p>
      ) : null}
      <FormAlert message={error} />
      <HydratedControls>
        <fieldset disabled={pending} className="grid min-w-0 gap-4">
          <Section
            title={m.workspace_members_title()}
            actions={
              <span className="text-muted-foreground text-xs">
                {page.maxSeats === null
                  ? m.workspace_seats_unlimited({ used: page.memberCount })
                  : m.workspace_seats({ used: page.memberCount, max: page.maxSeats })}
              </span>
            }
          >
            {seatsFull && !page.workspace.isPersonal ? (
              <p role="status" className="text-sm text-warning-strong">
                {page.memberCount > (page.maxSeats ?? 0)
                  ? m.workspace_seats_over()
                  : m.workspace_seats_full()}
              </p>
            ) : null}
            <ul className="divide-y text-[13px]">
              {page.members.map((member) => (
                <li key={member.id} className="flex flex-wrap items-center gap-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{member.name}</span>{' '}
                    <span className="text-muted-foreground">({member.email})</span>{' '}
                    <Tag tone={member.role === 'member' ? 'neutral' : 'info'}>
                      {roleLabel(member.role)}
                    </Tag>
                  </span>
                  {page.canManage && member.role !== 'owner' ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <select
                        aria-label={m.workspace_role_for({ name: member.name })}
                        className={selectClass}
                        value={member.role}
                        onChange={(e) =>
                          void run('update-member-role', {
                            memberId: member.id,
                            role: e.target.value,
                          })
                        }
                      >
                        <option value="member">{m.workspace_role_member()}</option>
                        <option value="admin">{m.workspace_role_admin()}</option>
                      </select>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (window.confirm(m.workspace_remove_confirm({ name: member.name })))
                            void run('remove-member', { memberIdOrEmail: member.id })
                        }}
                      >
                        {m.workspace_remove()}
                      </Button>
                      {page.role === 'owner' ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            if (window.confirm(m.workspace_transfer_confirm({ name: member.name })))
                              void run('transfer-owner', { memberId: member.id })
                          }}
                        >
                          {m.workspace_transfer()}
                        </Button>
                      ) : null}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </Section>
          {inviteLinks ? (
            <InviteLinksPanel
              slug={page.workspace.slug}
              state={inviteLinks}
              seatsFull={seatsFull}
            />
          ) : null}
          {page.canManage ? (
            <Section title={m.workspace_email_invite_title()}>
              <p className="text-muted-foreground text-xs">{m.workspace_email_invite_hint()}</p>
              <form
                aria-label={m.workspace_email_invite_title()}
                onSubmit={(event) => {
                  event.preventDefault()
                  void run('invite-member', { email, role })
                }}
                className="flex flex-wrap items-end gap-3"
              >
                <span className="grid gap-1">
                  <Label htmlFor="invite-email">{m.workspace_invite_email()}</Label>
                  <Input
                    id="invite-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </span>
                <span className="grid gap-1">
                  <Label htmlFor="invite-role">{m.workspace_invite_role()}</Label>
                  <select
                    id="invite-role"
                    className={selectClass}
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                  >
                    <option value="member">{m.workspace_role_member()}</option>
                    <option value="admin">{m.workspace_role_admin()}</option>
                  </select>
                </span>
                <Button type="submit" disabled={seatsFull}>
                  {m.workspace_send_invite()}
                </Button>
              </form>
              {page.invitations.length ? (
                <ul className="grid gap-2 text-[13px]" aria-label={m.workspace_invitations_title()}>
                  {page.invitations.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center gap-2">
                      <span>
                        {m.workspace_invitation_row({
                          email: i.email,
                          role: roleLabel(i.role ?? 'member'),
                          status: i.status,
                          date: new Date(i.expiresAt).toISOString().slice(0, 10),
                        })}
                      </span>
                      {i.status === 'pending' ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void run('cancel-invitation', { invitationId: i.id })}
                        >
                          {m.workspace_revoke_invitation()}
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Section>
          ) : null}
        </fieldset>
      </HydratedControls>
    </div>
  )
}
