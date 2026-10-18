/**
 * 认证流程中需要发出的邮件。`createAuth` 只负责在 Better Auth 的发送点组装消息，
 * 实际投递由调用方注入的 `SendAuthEmail` 完成（后续接 `EMAIL_QUEUE`，见 tasks.md 3.2）；
 * 测试中注入记录消息的假实现，不调用任何外部服务。
 */
export type AuthEmail =
  | { readonly type: 'verify-email'; readonly to: string; readonly url: string }
  | { readonly type: 'reset-password'; readonly to: string; readonly url: string }
  | { readonly type: 'magic-link'; readonly to: string; readonly url: string }
  | {
      readonly type: 'otp'
      readonly to: string
      readonly otp: string
      readonly purpose: 'sign-in' | 'email-verification' | 'forget-password' | 'change-email'
    }
  | {
      readonly type: 'invitation'
      readonly to: string
      readonly invitationId: string
      readonly workspaceName: string
      readonly inviterName: string
      readonly role: string
    }

export type SendAuthEmail = (email: AuthEmail) => Promise<void>
