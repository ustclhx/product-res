// @ts-nocheck -- intentionally unsafe lint fixture
import { creditGrant as grants, creditHold, creditDebt, creditHoldAllocation } from '@product-res/db'
import * as schema from '@product-res/db/schema'
import { sql as query } from 'drizzle-orm'

// biome-ignore lint/plugin: business code cannot suppress credit ownership
await db.insert(grants).values({}) // expect-credit-write
await tx.update(creditHold).set({}) // expect-credit-write
await db.delete(schema.creditLedger) // expect-credit-write
await scoped.insert(creditDebt, {}) // expect-credit-write
await scoped.update(grants, {}, condition) // expect-credit-write
await scoped.delete(creditHoldAllocation, condition) // expect-credit-write
await scoped.updateById(schema.creditHold, id, {}) // expect-credit-write
await scoped.deleteById(creditHold, id) // expect-credit-write
await schema.creditHold.updateById(id, {}) // expect-credit-write
const local = grants
await db.update(local) // expect-credit-write
const { creditLedger: ledger } = schema
await db.insert(ledger) // expect-credit-write
await db.execute(query`INSERT INTO credit_grant (amount) VALUES (1)`) // expect-credit-write
await db.execute(query`UPDATE "public"."credit_hold" SET status = 'held'`) // expect-credit-write
await db.execute(query`DELETE FROM ${grants} WHERE id = ${id}`) // expect-credit-write
await db.execute(query.raw('TRUNCATE TABLE public.credit_debt, "credit_ledger"')) // expect-credit-write
await db.execute(query`/* lock */ UPDATE credit_hold_allocation SET amount = ${amount}`) // expect-credit-write
