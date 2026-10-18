import { grantSignupBonus } from '@product-res/billing'
import { createServerFn } from '@tanstack/react-start'
import { withCredits } from '../../server/feature-gates.ts'
import { withSession } from '../../server/middleware.ts'
import { templateConfig } from '../../server/template-config.ts'

/** Identity and verification are resolved from the database, never from browser input. */
export const claimSignupBonus = createServerFn({ method: 'POST' })
  .middleware([withCredits, withSession])
  .handler(({ context }) =>
    grantSignupBonus({ db: context.db, userId: context.user.id, config: templateConfig.billing }),
  )
