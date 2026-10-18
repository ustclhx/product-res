import type { EmailLocale } from './locale.ts'

/** 各模板的输入（必须可 JSON 序列化：3.2 会把它放进 EMAIL_QUEUE 消息）。 */
export interface EmailTemplateProps {
  'waitlist-invitation': { readonly url: string }
  'newsletter-confirmation': { readonly url: string }
  newsletter: { readonly subject: string; readonly body: string; readonly unsubscribeUrl: string }

  'refund-update': {
    readonly status: 'approved' | 'rejected' | 'refunded'
    readonly amount: number | null
    readonly currency: string
    readonly note: string
    readonly supportEmail: string
  }

  /** 注册后的邮箱验证 */
  'verify-email': { readonly url: string }
  /** 邮箱验证码（emailOTP 插件），用途决定文案 */
  otp: { readonly otp: string; readonly purpose: OtpPurpose; readonly expiresInMinutes: number }
  /** 魔法链接登录 */
  'magic-link': { readonly url: string; readonly expiresInMinutes: number }
  /** 找回密码 */
  'reset-password': { readonly url: string; readonly expiresInMinutes: number }
  /** 团队空间邀请 */
  'workspace-invitation': {
    readonly url: string
    readonly workspaceName: string
    readonly inviterName: string
    readonly role: InvitationRole
    readonly expiresInDays: number
  }
}

export type EmailTemplateName = keyof EmailTemplateProps

/** 与 Better Auth emailOTP 插件 `sendVerificationOTP` 的 `type` 一致 */
export type OtpPurpose = 'sign-in' | 'email-verification' | 'forget-password'
/** 自定义团队后端支持的邀请角色 */
export type InvitationRole = 'owner' | 'admin' | 'member'

/** 所有模板共用的上下文 */
export interface CopyContext {
  readonly appName: string
  /** 收件人称呼；缺省时使用通用问候 */
  readonly recipientName?: string | undefined
}

/** 一封邮件的文案；渲染时由统一布局（templates/layout.tsx）排版。 */
export interface EmailCopy {
  readonly subject: string
  /** 收件箱列表中显示的预览文字 */
  readonly preview: string
  readonly heading: string
  readonly greeting: string
  readonly paragraphs: readonly string[]
  /** 按钮；有按钮时同时显示可复制的链接 */
  readonly action?: { readonly label: string; readonly url: string }
  /** 验证码 */
  readonly code?: string
  /** 按钮无法点击时的提示 */
  readonly linkHint: string
  /** 页脚：非本人操作时的说明 */
  readonly footer: string
}

type CopyBuilders = {
  readonly [N in EmailTemplateName]: (props: EmailTemplateProps[N], ctx: CopyContext) => EmailCopy
}

const minutesEn = (n: number) => (n === 1 ? '1 minute' : `${n} minutes`)
const daysEn = (n: number) => (n === 1 ? '1 day' : `${n} days`)

const en: CopyBuilders = {
  'waitlist-invitation': ({ url }, { appName, recipientName }) => ({
    subject: `You are invited to ${appName}`,
    preview: 'Your registration invitation is ready.',
    heading: 'You are invited',
    greeting: greetingEn(recipientName),
    paragraphs: [
      'Use this link to create your account, even while registration is closed. This invitation expires in 7 days.',
    ],
    action: { label: 'Create account', url },
    linkHint: 'Copy this link if the button does not work:',
    footer: 'If you did not join the waitlist, ignore this email.',
  }),
  'newsletter-confirmation': ({ url }, { appName, recipientName }) => ({
    subject: `Confirm your ${appName} subscription`,
    preview: 'Confirm to receive our newsletter.',
    heading: 'Confirm your subscription',
    greeting: greetingEn(recipientName),
    paragraphs: [
      'Click below to subscribe. You will only receive newsletters after confirming. This link expires in 24 hours.',
    ],
    action: { label: 'Confirm subscription', url },
    linkHint: 'Copy this link if the button does not work:',
    footer: 'If you did not subscribe, ignore this email.',
  }),
  newsletter: ({ subject, body, unsubscribeUrl }, { recipientName }) => ({
    subject,
    preview: subject,
    heading: subject,
    greeting: greetingEn(recipientName),
    paragraphs: [body],
    action: { label: 'Unsubscribe', url: unsubscribeUrl },
    linkHint: 'You can unsubscribe with this link:',
    footer: 'You received this email because you confirmed your subscription.',
  }),

  'refund-update': (
    { status, amount, currency, note, supportEmail },
    { appName, recipientName },
  ) => ({
    subject: `Your ${appName} refund request: ${status}`,
    preview: `Your refund request is ${status}.`,
    heading: 'Refund request update',
    greeting: greetingEn(recipientName),
    paragraphs: [
      status === 'approved'
        ? 'Your request was approved. The refund is not yet confirmed by the payment provider.'
        : status === 'refunded'
          ? 'The payment provider has confirmed your refund.'
          : 'Your refund request was rejected.',
      ...(amount === null ? [] : [`Amount: ${(amount / 100).toFixed(2)} ${currency}.`]),
      ...(note ? [note] : []),
      `For help, contact ${supportEmail}.`,
    ],
    linkHint: '',
    footer: 'This update remains available by email if you have deleted your account.',
  }),

  'verify-email': ({ url }, { appName, recipientName }) => ({
    subject: `Verify your email for ${appName}`,
    preview: `Confirm your email address to finish setting up your ${appName} account.`,
    heading: 'Verify your email',
    greeting: greetingEn(recipientName),
    paragraphs: [
      `Thanks for signing up for ${appName}. Please confirm your email address by clicking the button below.`,
    ],
    action: { label: 'Verify email', url },
    linkHint: 'If the button does not work, copy and paste this link into your browser:',
    footer: `If you did not create a ${appName} account, you can safely ignore this email.`,
  }),
  otp: ({ otp, purpose, expiresInMinutes }, { appName, recipientName }) => {
    const purposeText = {
      'sign-in': `sign in to ${appName}`,
      'email-verification': `verify your email for ${appName}`,
      'forget-password': `reset your ${appName} password`,
    }[purpose]
    return {
      subject: `${otp} is your ${appName} verification code`,
      preview: `Use this code to ${purposeText}.`,
      heading: 'Your verification code',
      greeting: greetingEn(recipientName),
      paragraphs: [
        `Use the code below to ${purposeText}. It expires in ${minutesEn(expiresInMinutes)}.`,
      ],
      code: otp,
      linkHint: '',
      footer:
        'Never share this code with anyone. If you did not request it, you can ignore this email.',
    }
  },
  'magic-link': ({ url, expiresInMinutes }, { appName, recipientName }) => ({
    subject: `Sign in to ${appName}`,
    preview: `Your sign-in link for ${appName}.`,
    heading: `Sign in to ${appName}`,
    greeting: greetingEn(recipientName),
    paragraphs: [
      `Click the button below to sign in. This link expires in ${minutesEn(expiresInMinutes)} and can only be used once.`,
    ],
    action: { label: 'Sign in', url },
    linkHint: 'If the button does not work, copy and paste this link into your browser:',
    footer: 'If you did not request this link, you can safely ignore this email.',
  }),
  'reset-password': ({ url, expiresInMinutes }, { appName, recipientName }) => ({
    subject: `Reset your ${appName} password`,
    preview: `Follow this link to choose a new password for ${appName}.`,
    heading: 'Reset your password',
    greeting: greetingEn(recipientName),
    paragraphs: [
      `We received a request to reset the password for your ${appName} account. Click the button below to choose a new password. This link expires in ${minutesEn(expiresInMinutes)}.`,
    ],
    action: { label: 'Reset password', url },
    linkHint: 'If the button does not work, copy and paste this link into your browser:',
    footer:
      'If you did not request a password reset, you can ignore this email; your password will not change.',
  }),
  'workspace-invitation': (
    { url, workspaceName, inviterName, role, expiresInDays },
    { appName, recipientName },
  ) => ({
    subject: `${inviterName} invited you to join ${workspaceName} on ${appName}`,
    preview: `Join the ${workspaceName} workspace on ${appName}.`,
    heading: `Join ${workspaceName}`,
    greeting: greetingEn(recipientName),
    paragraphs: [
      `${inviterName} has invited you to join the ${workspaceName} workspace on ${appName} as ${{ owner: 'an owner', admin: 'an admin', member: 'a member' }[role]}.`,
      `This invitation expires in ${daysEn(expiresInDays)}.`,
    ],
    action: { label: 'Accept invitation', url },
    linkHint: 'If the button does not work, copy and paste this link into your browser:',
    footer: 'If you were not expecting this invitation, you can ignore this email.',
  }),
}

const zh: CopyBuilders = {
  'waitlist-invitation': ({ url }, { appName, recipientName }) => ({
    subject: `邀请你注册 ${appName}`,
    preview: '你的注册邀请已就绪。',
    heading: '注册邀请',
    greeting: greetingZh(recipientName),
    paragraphs: ['即使注册尚未开放，你也可以通过此链接创建账号。邀请 7 天内有效。'],
    action: { label: '创建账号', url },
    linkHint: '如果按钮无法点击，请复制此链接：',
    footer: '如果你没有加入等候名单，请忽略这封邮件。',
  }),
  'newsletter-confirmation': ({ url }, { appName, recipientName }) => ({
    subject: `确认订阅 ${appName} 通讯`,
    preview: '确认后才能收到邮件通讯。',
    heading: '确认订阅',
    greeting: greetingZh(recipientName),
    paragraphs: ['请点击下方按钮确认订阅。确认后才会收到通讯邮件。链接 24 小时内有效。'],
    action: { label: '确认订阅', url },
    linkHint: '如果按钮无法点击，请复制此链接：',
    footer: '如果你没有订阅，请忽略这封邮件。',
  }),
  newsletter: ({ subject, body, unsubscribeUrl }, { recipientName }) => ({
    subject,
    preview: subject,
    heading: subject,
    greeting: greetingZh(recipientName),
    paragraphs: [body],
    action: { label: '退订', url: unsubscribeUrl },
    linkHint: '你可以通过此链接退订：',
    footer: '你收到此邮件是因为已确认订阅。',
  }),

  'refund-update': (
    { status, amount, currency, note, supportEmail },
    { appName, recipientName },
  ) => ({
    subject: `${appName} 退款申请：${{ approved: '已批准', rejected: '已驳回', refunded: '已退款' }[status]}`,
    preview: `退款申请${{ approved: '已批准，待平台确认', rejected: '已驳回', refunded: '已由平台确认退款' }[status]}。`,
    heading: '退款申请进度',
    greeting: greetingZh(recipientName),
    paragraphs: [
      status === 'approved'
        ? '申请已批准，退款尚待支付平台确认。'
        : status === 'refunded'
          ? '支付平台已确认退款。'
          : '退款申请已驳回。',
      ...(amount === null ? [] : [`金额：${(amount / 100).toFixed(2)} ${currency}。`]),
      ...(note ? [note] : []),
      `如需帮助，请联系 ${supportEmail}。`,
    ],
    linkHint: '',
    footer: '删除账号后，退款结果仍会发送至申请时保存的联系邮箱。',
  }),

  'verify-email': ({ url }, { appName, recipientName }) => ({
    subject: `验证你的 ${appName} 邮箱`,
    preview: `确认邮箱地址，完成 ${appName} 账号注册。`,
    heading: '验证你的邮箱',
    greeting: greetingZh(recipientName),
    paragraphs: [`感谢注册 ${appName}。请点击下方按钮确认你的邮箱地址。`],
    action: { label: '验证邮箱', url },
    linkHint: '如果按钮无法点击，请将以下链接复制到浏览器中打开：',
    footer: `如果你没有注册 ${appName} 账号，请忽略这封邮件。`,
  }),
  otp: ({ otp, purpose, expiresInMinutes }, { appName, recipientName }) => {
    const purposeText = {
      'sign-in': `登录 ${appName}`,
      'email-verification': `验证你的 ${appName} 邮箱`,
      'forget-password': `重置 ${appName} 密码`,
    }[purpose]
    return {
      subject: `${otp} 是你的 ${appName} 验证码`,
      preview: `使用此验证码${purposeText}。`,
      heading: '你的验证码',
      greeting: greetingZh(recipientName),
      paragraphs: [`请使用以下验证码${purposeText}，验证码 ${expiresInMinutes} 分钟内有效。`],
      code: otp,
      linkHint: '',
      footer: '请勿将验证码告诉任何人。如果这不是你本人的操作，请忽略这封邮件。',
    }
  },
  'magic-link': ({ url, expiresInMinutes }, { appName, recipientName }) => ({
    subject: `登录 ${appName}`,
    preview: `你的 ${appName} 登录链接。`,
    heading: `登录 ${appName}`,
    greeting: greetingZh(recipientName),
    paragraphs: [`点击下方按钮即可登录。链接 ${expiresInMinutes} 分钟内有效，且只能使用一次。`],
    action: { label: '登录', url },
    linkHint: '如果按钮无法点击，请将以下链接复制到浏览器中打开：',
    footer: '如果这不是你本人的操作，请忽略这封邮件。',
  }),
  'reset-password': ({ url, expiresInMinutes }, { appName, recipientName }) => ({
    subject: `重置你的 ${appName} 密码`,
    preview: `通过此链接为 ${appName} 账号设置新密码。`,
    heading: '重置密码',
    greeting: greetingZh(recipientName),
    paragraphs: [
      `我们收到了重置你 ${appName} 账号密码的请求。请点击下方按钮设置新密码，链接 ${expiresInMinutes} 分钟内有效。`,
    ],
    action: { label: '重置密码', url },
    linkHint: '如果按钮无法点击，请将以下链接复制到浏览器中打开：',
    footer: '如果这不是你本人的操作，请忽略这封邮件，你的密码不会改变。',
  }),
  'workspace-invitation': (
    { url, workspaceName, inviterName, role, expiresInDays },
    { appName, recipientName },
  ) => ({
    subject: `${inviterName} 邀请你加入 ${appName} 上的 ${workspaceName}`,
    preview: `加入 ${appName} 上的 ${workspaceName} 空间。`,
    heading: `加入 ${workspaceName}`,
    greeting: greetingZh(recipientName),
    paragraphs: [
      `${inviterName} 邀请你以${{ owner: '所有者', admin: '管理员', member: '成员' }[role]}身份加入 ${appName} 上的 ${workspaceName} 空间。`,
      `邀请 ${expiresInDays} 天内有效。`,
    ],
    action: { label: '接受邀请', url },
    linkHint: '如果按钮无法点击，请将以下链接复制到浏览器中打开：',
    footer: '如果你不认识邀请人，请忽略这封邮件。',
  }),
}

function greetingEn(name: string | undefined): string {
  return name ? `Hi ${name},` : 'Hi,'
}

function greetingZh(name: string | undefined): string {
  return name ? `${name}，你好：` : '你好：'
}

export const copies: { readonly [L in EmailLocale]: CopyBuilders } = { en, zh }
