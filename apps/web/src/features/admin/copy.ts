import { m } from '../../paraglide/messages.js'
// 后台文案在访问时读取当前语言，避免跨请求共享已翻译的字符串。
export const ADMIN_COPY = {
  get title() {
    return m.admin_admin()
  },
  get heading() {
    return m.admin_admin()
  },
  get signedInAs() {
    return m.admin_signed_in_as()
  },
  get backToApp() {
    return m.admin_back_to_app()
  },
  get signOut() {
    return m.admin_sign_out()
  },
  get signingOut() {
    return m.admin_signing_out()
  },
  get signOutFailed() {
    return m.admin_could_not_sign_out_please_try_again()
  },
  nav: {
    get label() {
      return m.admin_admin_sections()
    },
    get overview() {
      return m.admin_overview()
    },
    groups: {
      get people() {
        return m.admin_users_workspaces()
      },
      get billing() {
        return m.admin_billing()
      },
      get ai() {
        return m.admin_ai()
      },
      get operations() {
        return m.admin_operations()
      },
    },
    get users() {
      return m.admin_users()
    },
    get workspaces() {
      return m.admin_workspaces()
    },
    get credits() {
      return m.admin_credit_adjustments()
    },
    get payments() {
      return m.admin_payments()
    },
    get subscriptions() {
      return m.admin_subscriptions()
    },
    get purchases() {
      return m.admin_one_time_purchases()
    },
    get refunds() {
      return m.admin_refund_reviews()
    },
    get plans() {
      return m.admin_plan_model_access()
    },
    get webhooks() {
      return m.admin_webhook_events()
    },
    get models() {
      return m.admin_models()
    },
    get metrics() {
      return m.admin_metrics()
    },
    get audit() {
      return m.admin_audit_log()
    },
    get settings() {
      return m.admin_settings()
    },
    get waitlist() {
      return m.admin_waitlist()
    },
  },
  overview: {
    get heading() {
      return m.admin_overview()
    },
    get description() {
      return m.admin_key_numbers_from_the_latest_daily_summaries_and()
    },
    metricsRange: (from: string, to: string) => m.admin_daily_summaries_utc({ from: from, to: to }),
    get metricsUnavailable() {
      return m.admin_metrics_are_unavailable_right_now_shortcuts_still_work()
    },
    get noSummaries() {
      return m.admin_no_daily_summaries_yet()
    },
    get registrations() {
      return m.admin_registrations()
    },
    get paidWorkspaces() {
      return m.admin_paid_workspaces()
    },
    get paidConversion() {
      return m.admin_paid_conversion()
    },
    get creditsConsumed() {
      return m.admin_credits_consumed()
    },
    get shortcuts() {
      return m.admin_shortcuts()
    },
  },
  get empty() {
    return m.admin_no_records_yet()
  },
  get adjustCredits() {
    return m.admin_adjust_credits()
  },
} as const
