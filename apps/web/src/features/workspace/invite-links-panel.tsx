import type { InviteLinkStatus, InviteLinkSummary } from '@product-res/auth'
import { Button, Input, Label, Tag, type Tone } from '@product-res/ui'
import { useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { FormAlert } from '../auth/auth-layout.tsx'
import { formatTime, Section, SimpleTable } from '../data-center/shared.tsx'
import { createInviteLinkFn, revokeInviteLinkFn } from './invite-links.functions.ts'
import { inviteLinkErrorMessage, roleLabel } from './labels.ts'

/** null = 当前成员不可管理（member、个人空间或只读），不渲染区块 */
export type InviteLinksState = readonly InviteLinkSummary[] | null

const STATUS: Record<InviteLinkStatus, { label: () => string; tone: Tone }> = {
  active: { label: () => m.invite_links_status_active(), tone: 'success' },
  revoked: { label: () => m.invite_links_status_revoked(), tone: 'neutral' },
  expired: { label: () => m.invite_links_status_expired(), tone: 'warning' },
  exhausted: { label: () => m.invite_links_status_exhausted(), tone: 'warning' },
  inactive: { label: () => m.invite_links_status_inactive(), tone: 'danger' },
}

const selectClass = 'h-9 rounded-md border bg-background px-2 text-[13px]'

/** 空间设置的邀请链接区块（add-team-invite-links 4.2）：生成、一次性复制、列表与作废 */
export function InviteLinksPanel({
  slug,
  state,
  seatsFull,
}: {
  slug: string
  state: readonly InviteLinkSummary[]
  seatsFull: boolean
}) {
  const [links, setLinks] = useState(state)
  const [role, setRole] = useState<'member' | 'admin'>('member')
  const [ttlDays, setTtlDays] = useState<1 | 7 | 30>(7)
  const [maxUses, setMaxUses] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<string | null>(null)
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null)

  async function generate() {
    setPending(true)
    setError(null)
    setCopied(null)
    try {
      const result = await createInviteLinkFn({
        data: { slug, role, ttlDays, maxUses: maxUses.trim() ? Number(maxUses) : null },
      })
      if ('error' in result) {
        setError(inviteLinkErrorMessage(result.error))
        return
      }
      setCreated(`${window.location.origin}/join/${result.token}`)
      setLinks((current) => [result.link, ...current])
      setMaxUses('')
    } catch {
      setError(m.invite_links_failed())
    } finally {
      setPending(false)
    }
  }

  async function revoke(linkId: string) {
    if (!window.confirm(m.invite_links_revoke_confirm())) return
    setPending(true)
    setError(null)
    try {
      const result = await revokeInviteLinkFn({ data: { slug, linkId } })
      if ('error' in result) setError(inviteLinkErrorMessage(result.error))
      else setLinks((current) => current.map((l) => (l.id === linkId ? result.link : l)))
    } catch {
      setError(m.invite_links_failed())
    } finally {
      setPending(false)
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setCopied('ok')
    } catch {
      setCopied('failed')
    }
  }

  const validMaxUses = !maxUses.trim() || /^[1-9]\d{0,2}$|^1000$/.test(maxUses.trim())
  return (
    <Section title={m.invite_links_title()}>
      <p className="text-muted-foreground text-xs">{m.invite_links_hint()}</p>
      <FormAlert message={error} />
      <form
        aria-label={m.invite_links_form()}
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void generate()
        }}
      >
        <span className="grid gap-1">
          <Label htmlFor="invite-link-role">{m.invite_links_role()}</Label>
          <select
            id="invite-link-role"
            className={selectClass}
            value={role}
            onChange={(e) => setRole(e.target.value === 'admin' ? 'admin' : 'member')}
          >
            <option value="member">{m.invite_links_role_member()}</option>
            <option value="admin">{m.invite_links_role_admin()}</option>
          </select>
        </span>
        <span className="grid gap-1">
          <Label htmlFor="invite-link-ttl">{m.invite_links_ttl()}</Label>
          <select
            id="invite-link-ttl"
            className={selectClass}
            value={ttlDays}
            onChange={(e) => setTtlDays(Number(e.target.value) as 1 | 7 | 30)}
          >
            {([1, 7, 30] as const).map((days) => (
              <option key={days} value={days}>
                {m.invite_links_ttl_option({ days })}
              </option>
            ))}
          </select>
        </span>
        <span className="grid gap-1">
          <Label htmlFor="invite-link-max">{m.invite_links_max_uses()}</Label>
          <Input
            id="invite-link-max"
            inputMode="numeric"
            className="w-28"
            placeholder={m.invite_links_unlimited()}
            value={maxUses}
            aria-invalid={!validMaxUses}
            aria-describedby="invite-link-max-hint"
            onChange={(e) => setMaxUses(e.target.value)}
          />
        </span>
        <Button type="submit" disabled={pending || seatsFull || !validMaxUses}>
          {pending ? m.invite_links_generating() : m.invite_links_generate()}
        </Button>
      </form>
      <p id="invite-link-max-hint" className="text-muted-foreground text-xs">
        {m.invite_links_max_uses_hint()}
      </p>
      {created ? (
        <div className="grid gap-2 rounded-lg border border-primary/30 bg-primary-soft p-3">
          <p role="status" className="text-[13px] text-primary">
            {m.invite_links_created()}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              readOnly
              aria-label={m.invite_links_url()}
              value={created}
              className="min-w-0 flex-1 font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button type="button" variant="outline" onClick={() => void copy(created)}>
              {copied === 'ok' ? m.invite_links_copied() : m.invite_links_copy()}
            </Button>
          </div>
          {copied === 'failed' ? (
            <p className="text-destructive text-xs">{m.invite_links_copy_failed()}</p>
          ) : null}
        </div>
      ) : null}
      <SimpleTable
        head={[
          m.invite_links_col_role(),
          m.invite_links_col_status(),
          m.invite_links_col_uses(),
          m.invite_links_col_expires(),
          m.invite_links_col_creator(),
          m.invite_links_col_actions(),
        ]}
        empty={links.length === 0}
      >
        {links.map((link) => (
          <tr key={link.id} data-testid="invite-link-row">
            <td className="px-3 py-2">{roleLabel(link.role)}</td>
            <td className="px-3 py-2">
              <Tag tone={STATUS[link.status].tone}>{STATUS[link.status].label()}</Tag>
            </td>
            <td className="px-3 py-2 tabular-nums">
              {link.usedCount} / {link.maxUses ?? m.invite_links_unlimited()}
            </td>
            <td className="px-3 py-2">{formatTime(link.expiresAt)}</td>
            <td className="px-3 py-2">{link.createdBy.name}</td>
            <td className="px-3 py-2">
              {link.status !== 'revoked' ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => void revoke(link.id)}
                >
                  {m.invite_links_revoke()}
                </Button>
              ) : null}
            </td>
          </tr>
        ))}
      </SimpleTable>
    </Section>
  )
}
