import { Button, useAppForm } from '@product-res/ui'
import { Link, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { templateConfig } from '../../server/template-config.ts'
import { FormAlert } from '../auth/auth-layout.tsx'
import { Section } from '../data-center/shared.tsx'
import { teamWorkspaceInput, type WorkspacePage } from '../workspace/components.tsx'
import { clearWorkspacePageCache } from '../workspace/load-page.ts'
import { groupLabel, groupTableCounts, tableLabel, transferActionError } from './labels.ts'
import { Modal } from './modal.tsx'
import { getUpgradePreview, startWorkspaceUpgrade } from './transfer.functions.ts'

/**
 * 个人空间设置的“升级为团队空间”（add-workspace-data-transfer tasks 6.1，design D9、D11）：
 * 卡片 → 预览对话框（随迁移的数据条数、留在个人空间的内容、新空间需开通提示）→ 新团队名称 / 地址
 * → 确认后跳转到流转进度页。
 */

export type UpgradePreview = Awaited<ReturnType<typeof getUpgradePreview>>
type StartUpgrade = typeof startWorkspaceUpgrade

/** 只在开关开启、多租户、当前是本人个人空间时显示（个人空间 id 等于用户 id） */
export function upgradeCardVisible(
  page: Pick<WorkspacePage, 'multiTenant' | 'workspace' | 'user'>,
  enabled: boolean = templateConfig.tenancy.dataTransfer,
): boolean {
  return (
    enabled && page.multiTenant && page.workspace.isPersonal && page.workspace.id === page.user.id
  )
}

/** 幂等键在对话框打开时生成一次；网络重试或重复点击沿用同一个键，服务端返回同一流转 */
export function newIdempotencyKey(): string {
  return `upgrade-${crypto.randomUUID()}`
}

export function upgradeSubmitter(start: StartUpgrade, slug: string, idempotencyKey: string) {
  return (value: { name: string; slug: string }) =>
    start({ data: { slug, name: value.name.trim(), newSlug: value.slug, idempotencyKey } })
}

export function UpgradeCard({ page }: { page: WorkspacePage }) {
  const [open, setOpen] = useState(false)
  const slug = page.workspace.slug
  return (
    <Section title={m.transfer_upgrade_title()}>
      <p className="text-muted-foreground text-xs">{m.transfer_upgrade_hint()}</p>
      {page.transfer ? (
        <p role="status" className="text-sm text-warning-strong">
          {m.transfer_upgrade_in_progress()}{' '}
          {page.transfer.viewable ? (
            <Link
              to="/app/$slug/settings/transfers/$transferId"
              params={{ slug, transferId: page.transfer.id }}
              className="underline"
            >
              {m.transfer_upgrade_view_progress()}
            </Link>
          ) : null}
        </p>
      ) : (
        <div>
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            {m.transfer_upgrade_open()}
          </Button>
        </div>
      )}
      {open ? <UpgradeDialog slug={slug} onClose={() => setOpen(false)} /> : null}
    </Section>
  )
}

function UpgradeDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
  // 对话框每次打开都会重新挂载：这里生成的键在本次打开期间保持不变
  const [idempotencyKey] = useState(newIdempotencyKey)
  const [preview, setPreview] = useState<UpgradePreview | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [understood, setUnderstood] = useState(false)
  const router = useRouter()
  useEffect(() => {
    let live = true
    getUpgradePreview({ data: { slug } })
      .then((value) => live && setPreview(value))
      .catch(() => live && setLoadError(true))
    return () => {
      live = false
    }
  }, [slug])
  const form = useAppForm({
    defaultValues: { name: '', slug: '' },
    validators: { onSubmit: teamWorkspaceInput },
    onSubmit: async ({ value }) => {
      setError(null)
      try {
        const started = await upgradeSubmitter(startWorkspaceUpgrade, slug, idempotencyKey)(value)
        // 两个空间进入只读：布局缓存需要重新获取以显示横幅
        clearWorkspacePageCache()
        await router.navigate({
          to: '/app/$slug/settings/transfers/$transferId',
          params: { slug, transferId: started.transferId },
        })
        // 路由默认先渲染旧布局再后台重验证：立即重取，横幅与进度页同时出现
        await router.invalidate()
      } catch (e) {
        setError(transferActionError(e, m.transfer_upgrade_failed()))
      }
    },
  })
  return (
    <Modal open title={m.transfer_upgrade_dialog_title()} onClose={onClose} className="max-w-xl">
      {preview ? (
        <>
          <UpgradePreviewBody preview={preview} />
          {preview.eligible ? (
            <form.AppForm>
              <form.Form aria-label={m.transfer_upgrade_form_title()} className="gap-3">
                <h3 className="text-xs font-semibold">{m.transfer_upgrade_form_title()}</h3>
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
                <label className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-3.5 accent-primary"
                    checked={understood}
                    onChange={(e) => setUnderstood(e.target.checked)}
                  />
                  <span>{m.transfer_upgrade_confirm_check()}</span>
                </label>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                    {m.transfer_cancel()}
                  </Button>
                  <form.SubmitButton
                    size="sm"
                    disabled={!understood}
                    pendingLabel={m.transfer_upgrade_submitting()}
                  >
                    {m.transfer_upgrade_submit()}
                  </form.SubmitButton>
                </div>
              </form.Form>
            </form.AppForm>
          ) : (
            <div className="flex justify-end">
              <Button type="button" variant="outline" size="sm" onClick={onClose}>
                {m.transfer_close()}
              </Button>
            </div>
          )}
        </>
      ) : loadError ? (
        <p role="alert" className="text-destructive text-sm">
          {m.transfer_upgrade_preview_failed()}
        </p>
      ) : (
        <p role="status" className="text-muted-foreground text-sm">
          {m.transfer_upgrade_loading()}
        </p>
      )}
    </Modal>
  )
}

function reasonText(code: string, preview: UpgradePreview): string {
  if (code === 'TRANSFER_IN_PROGRESS') return m.transfer_upgrade_reason_in_progress()
  if (code === 'WORKSPACE_LIMIT')
    return m.transfer_upgrade_reason_limit({
      count: String(preview.teamWorkspaces),
      max: String(preview.maxWorkspacesPerUser),
    })
  return m.transfer_upgrade_reason_unknown({ code })
}

/** 预览内容：纯渲染，便于测试 */
export function UpgradePreviewBody({ preview }: { preview: UpgradePreview }) {
  const groups = groupTableCounts(preview.tables)
  const { stays } = preview
  return (
    <div className="grid gap-3">
      {preview.reasons.length ? (
        <ul
          role="alert"
          className="grid gap-1 rounded-md bg-destructive-soft px-3 py-2 text-xs text-destructive"
        >
          {preview.reasons.map((code) => (
            <li key={code}>{reasonText(code, preview)}</li>
          ))}
        </ul>
      ) : null}
      <section className="grid gap-1.5" aria-label={m.transfer_upgrade_moves_title()}>
        <h3 className="flex flex-wrap items-baseline justify-between gap-2 text-xs font-semibold">
          {m.transfer_upgrade_moves_title()}
          <span className="font-normal text-muted-foreground">
            {m.transfer_upgrade_moves_total({ total: String(preview.total) })}
          </span>
        </h3>
        {groups.length ? (
          <ul className="grid gap-1" data-testid="upgrade-moves">
            {groups.map((g) => (
              <li key={g.group} className="rounded-md border px-3 py-1.5">
                <details>
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-2">
                    <span>{groupLabel(g.group)}</span>
                    <span className="font-mono">{g.total}</span>
                  </summary>
                  <ul className="mt-1 grid gap-0.5 text-xs text-muted-foreground">
                    {g.tables.map((t) => (
                      <li key={t.table} className="flex justify-between gap-2">
                        <span>{tableLabel(t.table)}</span>
                        <span className="font-mono">{t.count}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-xs">{m.transfer_upgrade_moves_empty()}</p>
        )}
      </section>
      <section className="grid gap-1.5" aria-label={m.transfer_upgrade_stays_title()}>
        <h3 className="text-xs font-semibold">{m.transfer_upgrade_stays_title()}</h3>
        <ul className="grid gap-0.5 text-xs text-muted-foreground" data-testid="upgrade-stays">
          <li>
            {stays.credits
              ? m.transfer_upgrade_stays_credits({
                  available: String(stays.credits.available),
                  held: String(stays.credits.held),
                })
              : m.transfer_upgrade_stays_credits_disabled()}
          </li>
          <li>{m.transfer_upgrade_stays_subscriptions({ count: String(stays.subscriptions) })}</li>
          <li>{m.transfer_upgrade_stays_ai({ count: String(stays.aiConversations) })}</li>
          <li>{m.transfer_upgrade_stays_files({ count: String(stays.files) })}</li>
          <li>{m.transfer_upgrade_stays_api_keys({ count: String(stays.apiKeys) })}</li>
          <li>{m.transfer_upgrade_stays_audit({ count: String(stays.auditLogs) })}</li>
        </ul>
      </section>
      {preview.targetRequiresActivation ? (
        <p
          className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-strong"
          data-testid="upgrade-activation"
        >
          {m.transfer_upgrade_activation_notice()}
        </p>
      ) : null}
      {stays.apiKeys > 0 ? (
        <p className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-strong">
          {m.transfer_upgrade_api_key_notice()}
        </p>
      ) : null}
      <p className="text-muted-foreground text-xs">{m.transfer_upgrade_readonly_notice()}</p>
    </div>
  )
}
