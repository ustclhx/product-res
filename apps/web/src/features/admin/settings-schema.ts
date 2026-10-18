import { z } from 'zod'

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) => value.replace(/\.$/, ''))
  .pipe(
    z
      .string()
      .max(253)
      .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  )

export const runtimeSettingsInput = z.object({
  signupEnabled: z.boolean(),
  announcement: z.string().trim().max(2000),
  signupBonusDomainBlacklist: z
    .array(domain)
    .max(1000)
    .transform((domains) => [...new Set(domains)]),
})

export type RuntimeSettingsInput = z.infer<typeof runtimeSettingsInput>
