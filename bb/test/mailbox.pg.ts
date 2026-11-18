import { afterAll } from "vitest"
import { makePostgresMailbox } from "../src/adapters/postgres/mailbox.ts"
import { mailboxContract } from "./mailbox-contract.ts"

// `bun run test:postgres` with DATABASE_URL set (not part of verify).
const url = process.env["DATABASE_URL"]
if (url === undefined) throw new Error("set DATABASE_URL to run the Postgres mailbox contract")
const pg = makePostgresMailbox(url)
afterAll(() => pg.end())

mailboxContract("postgres", () => pg.service, `t${Date.now()}-`)
