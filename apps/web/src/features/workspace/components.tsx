import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  useAppForm,
} from '@product-res/ui'
import { type ReactNode, useEffect, useState } from 'react'
import { z } from 'zod'
import { FormAlert } from '../auth/auth-layout.tsx'
import { actionResult, activateWorkspace, workspaceAction } from './client.ts'
import type { getWorkspacePage } from './workspace.functions.ts'

export type WorkspacePage = Awaited<ReturnType<typeof getWorkspacePage>>
export function HydratedControls({ children }: { children: ReactNode }) {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])
  return (
    <fieldset disabled={!hydrated} className="grid min-w-0 gap-4">
      {children}
    </fieldset>
  )
}

export function WorkspaceSwitcher({ page }: { page: WorkspacePage }) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  if (!page.multiTenant) return null
  return (
    <HydratedControls>
      <Label htmlFor="workspace-switcher">Switch workspace</Label>
      <select
        id="workspace-switcher"
        className="rounded-md border p-2"
        value={page.workspace.id}
        disabled={pending}
        onChange={async (event) => {
          const space = page.spaces.find((s) => s.id === event.target.value)
          if (!space) return
          setPending(true)
          setError(null)
          try {
            await activateWorkspace(space)
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not switch workspace.')
            setPending(false)
          }
        }}
      >
        {page.spaces.map((space) => (
          <option key={space.id} value={space.id}>
            {space.name}
            {space.isPersonal ? ' (personal)' : ''}
          </option>
        ))}
      </select>
      <FormAlert message={error} />
      <CreateTeam />
    </HydratedControls>
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
        setError(e instanceof Error ? e.message : 'Could not create workspace.')
      }
    },
  })
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(!open)}>
        Create team workspace
      </Button>
      {open ? (
        <form.AppForm>
          <form.Form aria-label="Create team workspace">
            <FormAlert message={error} />
            <form.AppField name="name">
              {(field) => <field.TextField label="Team name" />}
            </form.AppField>
            <form.AppField name="slug">
              {(field) => (
                <field.TextField
                  label="Workspace URL"
                  description="Lowercase letters, numbers and hyphens."
                />
              )}
            </form.AppField>
            <form.SubmitButton pendingLabel="Creating…">Create team</form.SubmitButton>
          </form.Form>
        </form.AppForm>
      ) : null}
    </>
  )
}

export function WorkspaceSettings({ page }: { page: WorkspacePage }) {
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
      setError(e instanceof Error ? e.message : 'Could not update workspace.')
      setPending(false)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace settings</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-6">
        <p>
          Seats: {page.memberCount} / {page.maxSeats ?? 'Unlimited'}
        </p>
        {seatsFull ? (
          <p role="status">
            {page.memberCount > (page.maxSeats ?? 0)
              ? 'This workspace exceeds its seat limit.'
              : 'All seats are in use.'}{' '}
            The owner must increase the limit or remove members before inviting anyone else.
          </p>
        ) : null}
        {page.readOnly ? (
          <p role="status">Team features are disabled. This workspace is read-only.</p>
        ) : null}
        <FormAlert message={error} />
        <HydratedControls>
          <fieldset disabled={pending} className="grid gap-6">
            {page.canManage ? (
              <form
                aria-label="Invite member"
                onSubmit={(event) => {
                  event.preventDefault()
                  void run('invite-member', { email, role })
                }}
                className="grid gap-3"
              >
                <Label htmlFor="invite-email">Invite email</Label>
                <Input
                  id="invite-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <Label htmlFor="invite-role">Invitation role</Label>
                <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
                <Button type="submit" disabled={seatsFull}>
                  Send invitation
                </Button>
              </form>
            ) : null}
            <h2 className="font-semibold">Members</h2>
            <ul className="grid gap-4">
              {page.members.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-3">
                  <span>
                    {m.name} ({m.email}) · {m.role}
                  </span>
                  {page.canManage && m.role !== 'owner' ? (
                    <>
                      <Label htmlFor={`role-${m.id}`}>Role for {m.name}</Label>
                      <select
                        id={`role-${m.id}`}
                        value={m.role}
                        onChange={(e) =>
                          void run('update-member-role', { memberId: m.id, role: e.target.value })
                        }
                      >
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </select>
                      <Button
                        variant="outline"
                        onClick={() => {
                          if (window.confirm(`Remove ${m.name} from this workspace?`))
                            void run('remove-member', { memberIdOrEmail: m.id })
                        }}
                      >
                        Remove
                      </Button>
                      {page.role === 'owner' ? (
                        <Button
                          variant="outline"
                          onClick={() => {
                            if (
                              window.confirm(
                                `Transfer ownership to ${m.name}? You will become an admin.`,
                              )
                            )
                              void run('transfer-owner', { memberId: m.id })
                          }}
                        >
                          Transfer ownership
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
            {!page.workspace.isPersonal && page.invitations.length ? (
              <>
                <h2 className="font-semibold">Invitations</h2>
                <ul className="grid gap-3">
                  {page.invitations.map((i) => (
                    <li key={i.id}>
                      {i.email} · {i.role} · {i.status} · expires{' '}
                      {new Date(i.expiresAt).toISOString().slice(0, 10)}{' '}
                      {page.canManage && i.status === 'pending' ? (
                        <Button
                          variant="outline"
                          onClick={() => void run('cancel-invitation', { invitationId: i.id })}
                        >
                          Revoke invitation
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </fieldset>
        </HydratedControls>
      </CardContent>
    </Card>
  )
}
