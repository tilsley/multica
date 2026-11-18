import { makeMemoryMailbox } from "../src/adapters/fake/mailbox.ts"
import { mailboxContract } from "./mailbox-contract.ts"

mailboxContract("in-memory fake", () => makeMemoryMailbox().service, "")
