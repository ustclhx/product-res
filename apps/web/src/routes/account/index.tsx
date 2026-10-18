import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { SignupBonusSection } from '../../features/billing/signup-section.tsx'
import { DeletionSection } from '../../features/deletion/deletion-section.tsx'
import { getAccount } from '../../features/settings/account.functions.ts'
import {
  EmailVerificationSection,
  PasswordSection,
  PreferencesSection,
  ProfileSection,
  TwoFactorSection,
} from '../../features/settings/account-sections.tsx'
import { ACCOUNT_COPY } from '../../features/settings/copy.ts'

// 用户设置页（tasks.md 5.2）：不在 /app/$slug 下，属于用户本人而非某个空间
export const Route = createFileRoute('/account/')({
  // 邮箱验证链接失败时 Better Auth 重定向回 callbackURL 并带上 ?error=
  validateSearch: z.object({ error: z.string().optional() }),
  loader: () => getAccount(),
  head: () => ({ meta: [{ title: ACCOUNT_COPY.title }] }),
  component: AccountPage,
})

function AccountPage() {
  const account = Route.useLoaderData()
  const { error } = Route.useSearch()
  const { user } = account
  return (
    <main className="mx-auto grid max-w-2xl gap-6 px-4 py-12">
      <h1 className="font-semibold text-3xl">{ACCOUNT_COPY.heading}</h1>
      <ProfileSection user={user} />
      <PreferencesSection user={user} locales={account.locales} />
      <EmailVerificationSection user={user} callbackError={error} />
      <SignupBonusSection
        email={user.email}
        verified={user.emailVerified}
        credits={account.signupBonusCredits}
      />
      <PasswordSection hasPassword={account.hasPassword} />
      {account.twoFactorAvailable && (
        <TwoFactorSection user={user} hasPassword={account.hasPassword} />
      )}
      <DeletionSection
        supportEmail={account.supportEmail}
        refundReminder={account.deletionRefunds}
      />
    </main>
  )
}
