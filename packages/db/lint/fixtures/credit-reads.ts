// @ts-nocheck -- lint fixture uses illustrative query clients
import { creditGrant, creditHold, creditLedger } from '@product-res/db'
import { sql } from 'drizzle-orm'
await db.select().from(creditGrant)
await scoped.select(creditHold)
await scoped.findById(creditLedger, id)
await db.query.creditGrant.findMany()
await db.execute(sql`SELECT * FROM credit_grant FOR UPDATE`)
await db.execute(sql`SELECT 'DELETE FROM credit_grant' AS example`)
await db.execute(sql`SELECT * FROM credit_hold -- UPDATE credit_grant SET amount = 1`)
await db.insert(payment).values({})
