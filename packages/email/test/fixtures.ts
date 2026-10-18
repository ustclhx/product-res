import type { EmailTemplateName, EmailTemplateProps } from '../src/index.ts'

/** 快照用的固定输入：每个模板一份，en / zh 共用。 */
export const APP_NAME = 'Acme'

type Fixture<N extends EmailTemplateName> = {
  readonly template: N
  readonly props: EmailTemplateProps[N]
  readonly recipientName?: string
}

export const fixtures: readonly Fixture<EmailTemplateName>[] = [
  {
    template: 'verify-email',
    props: { url: 'https://acme.test/api/auth/verify-email?token=tok_verify' },
    recipientName: 'Ada',
  },
  {
    template: 'otp',
    props: { otp: '482913', purpose: 'sign-in', expiresInMinutes: 5 },
  },
  {
    template: 'magic-link',
    props: {
      url: 'https://acme.test/api/auth/magic-link/verify?token=tok_magic',
      expiresInMinutes: 5,
    },
  },
  {
    template: 'reset-password',
    props: { url: 'https://acme.test/reset-password?token=tok_reset', expiresInMinutes: 60 },
    recipientName: 'Ada',
  },
  {
    template: 'workspace-invitation',
    props: {
      url: 'https://acme.test/invite/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      workspaceName: 'Research Lab',
      inviterName: 'Grace',
      role: 'admin',
      expiresInDays: 7,
    },
  },
]

export const LOCALES = ['en', 'zh'] as const

export function snapshotPath(template: string, locale: string, ext: 'html' | 'txt'): string {
  return `./__snapshots__/${template}.${locale}.${ext}`
}
