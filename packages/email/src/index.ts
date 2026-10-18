export {
  DEFAULT_EMAIL_LOCALE,
  EMAIL_LOCALES,
  type EmailLocale,
  resolveEmailLocale,
} from './locale.ts'
export type {
  EmailTemplateName,
  EmailTemplateProps,
  InvitationRole,
  OtpPurpose,
} from './messages.ts'
export { type RenderContext, type RenderedEmail, renderEmail } from './render.tsx'
export {
  createResendSender,
  isRetryableStatus,
  RESEND_API_URL,
  type ResendSenderOptions,
} from './resend.ts'
export {
  type EmailHeaders,
  type EmailMessage,
  EmailSendError,
  type EmailSender,
  isEmailSendError,
  type SendResult,
} from './sender.ts'
