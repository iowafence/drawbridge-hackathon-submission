# Integrated flow audit: threat model (lane A5)

Scope: the `DB_INTEGRATED_FLOW_V1` audit chain of the integrated flow (contract flow-v1 §10), implemented in
`apps/web/integrated/auditChain.ts` (the `AuditPort`) and `apps/web/integrated/auditExport.ts` (export, replay
verification, optional checkpoint). Tests: `apps/web/tests/integrated/unit/a5/`.

## The short version

**The chain is a local, unkeyed SHA-256 hash chain in a SQLite table. It does not stop a same-user rewrite.** Anyone
who can write the SQLite file (the account that runs the application, anything running as that account, a host
administrator) can change, shorten or empty the audit table, recompute every hash, and `verify` will pass. The
append-only triggers do not change this: the same person can drop them. The tests assert exactly this, on purpose.

The optional checkpoint is also unkeyed. It catches a rewrite or truncation only if the person who did it could not
also rewrite the checkpoint file. On one machine under one account, that person can.

So: this chain is evidence that the application recorded a consistent history and that nothing has been damaged by
accident or edited carelessly. It is not proof against a deliberate insider, and nothing in the product should say it is.

## 1. What is recorded

One row per event in `integrated_audit_event`, in the same SQLite file as the flow state, appended inside the flow
service's own transaction so a state change and its event commit or roll back together.

`{ chain, seq, prev, hash, flow_id, type, actor, from_state, to_state, flow_version, data, at_ms }`

- `seq` is global, contiguous from 1. `prev` is the hash of the previous event **of the same flow** (64 zeroes for a
  flow's first event). `hash = flowDigest("audit_event", event minus hash)` (CANON-1).
- `data` holds short scalars only: strings of at most 300 characters, safe integers, booleans, null.

### What is never stored, and how far that control goes

Refused at `append` with `AUDIT_FIELD_REFUSED` (the error names the rule, never the value):

- any data key matching the historic `audit.ts` pattern (`key|token|secret|password|passphrase|authorization|account_number|routing|iban|swift|bank`). A test pins the two patterns equal. Keys are refused, never renamed;
- nested objects and arrays, strings over 300 characters, non-integer numbers;
- strings that are multi-line, parse as a JSON object or array, or look like a bearer/basic credential, a JWT or a PEM block.

Evidence is represented only by `evidence_digest` and `document_id`.

**Limit.** These are shape and pattern checks, not a secret detector. A credential that looks like an ordinary
identifier, stored under an innocent key (`note: "<40 alphanumeric characters>"`), is accepted. So is a single-line
excerpt of evidence text under 300 characters. Callers must pass identifiers, codes, digests and statuses only. A
digest of a small or guessable input can be reversed by guessing.

## 2. What verification establishes

`auditPort.verify` recomputes the whole chain every time, with or without a `flowId`: row shape, contiguous `seq`,
each event's own hash, each flow's `prev` links, and the field rules above. Any defect anywhere returns
`AUDIT_CHAIN_BROKEN` (with `at_seq` and a `detail`), and the flow service refuses every operation.

`exportFlowAudit` adds a replay of one flow's events against `LEGAL_TRANSITIONS`: each transition must start from the
state the trail left the flow in, be a legal move, and raise `flow_version` by exactly one; audit-only events must not
change the version. It reports the `final_state` and `final_version` the trail supports. It derives nothing from a
broken chain, and it never upgrades a status: a create response stays `SUBMITTED`; only a recorded provider read
produces a `PROVIDER_*` state.

**Detected** (tests A5-07 to A5-09, A5-22, A5-23): accidental corruption; any edit, deletion, insertion, reordering,
relinking or cross-flow move made without recomputing hashes; a stored event that breaks a field rule; a history the
state machine could not have produced.

## 3. What the chain alone does not detect

Each row is an attack performed in a test named `LIMITATION`, with the test asserting that verification passes.

| Attack by anyone who can write the SQLite file | Result | Test |
|---|---|---|
| Change an event (for example who approved) and recompute the hashes | `verify` passes. The only trace is a different head, visible only to someone who kept the old one | A5-10 |
| Truncate the tail | `verify` and replay pass, and the trail says less than what happened: with the submit intent removed, a submitted request reads as approved and never submitted, and a second submit intent is accepted | A5-11, A5-24 |
| Delete every event | Reads as a store in which nothing ever happened | A5-12 |
| Fabricate a whole history, back-date it, name any actor | `verify` passes. `actor` and `at_ms` are the writer's claims | A5-12 |

Consequences for the other lanes:

- **One create attempt must never rest on the audit chain.** It rests on the flow store's constraints and the
  provider request id.
- Compare the export's `final_state` and `final_version` with the flow record. A disagreement means one of them was
  altered or the two were not committed together.
- `FlowView.audit.verified: true` means "internally consistent", not "unaltered".

## 4. The optional external checkpoint

`writeCheckpoint(tx, file)` writes `{seq, head, at_ms}` to a file that must be outside the directory holding the
SQLite file (checked against SQLite's own `database_list`, symlinks resolved). `verifyAgainstCheckpoint(tx, file)`
compares the chain with it.

`head` is a **rolling head over all events in `seq` order**, not the newest event's hash. Because `prev` links are
per flow, the newest event's hash commits only to that one flow; the rolling head commits to every flow up to `seq`.
`R(0)` is 64 zeroes and `R(i) = flowDigest("audit_event", {chain, rollup_prev: R(i-1), rollup_event: hash(i)})`.

Assumption for everything in the next table: **the attacker cannot write the checkpoint file.**

| Attack | Result | Test |
|---|---|---|
| Rewrite with recomputed hashes, in any flow, at or below the checkpoint | Detected, `AUDIT_REWRITTEN_BELOW_CHECKPOINT` | A5-31, A5-33 |
| Truncation below the checkpoint; deletion of every event | Detected, `AUDIT_TRUNCATED_BELOW_CHECKPOINT` | A5-32 |
| Missing or malformed checkpoint | Reported; never a pass | A5-34 |
| Routine re-checkpoint after tampering | Refused; the checkpoint that caught it is left in place | A5-35 |

What it does not do:

| Gap | Why | Test |
|---|---|---|
| Events after the checkpoint | Not covered at all. They can be removed or replaced. `uncovered_events` reports the size of the window | A5-40 |
| Attacker who can write both files | The checkpoint has no key. Rewriting the chain and writing a matching checkpoint passes | A5-41 |
| Rollback or replacement of the checkpoint | An older or freshly made checkpoint hides a truncation, and the next routine checkpoint then endorses it | A5-42 |
| Truth | A checkpoint vouches for stored rows. A history that was false when checkpointed stays "verified" | A5-43 |
| Time and authorship | `at_ms` is the local clock. Nothing identifies who wrote the checkpoint | — |

"Outside the data directory" is the only separation this code can enforce. It is real separation only if the file is
somewhere the application account cannot rewrite afterwards: another host or account, write-once storage, or a copy
of the three values sent to someone who keeps it. Two directories under one account demonstrate the mechanism and
protect against nothing deliberate.

A keyed (HMAC) checkpoint, with the key refused when stored beside the chain, closes the first forgery gap against an
attacker who lacks the key. It was built before the contract and is not part of flow-v1 (`{seq, head, at_ms}` has no
field for it); it is preserved on the local branch `a5-audit-precontract-22d0951` and listed in the lane handoff as a
requested contract change.

## 5. Out of scope

- A compromised application process. It can write false but well-formed events through the port.
- Authentication of actors. `human:<name>` is supplied by the caller.
- Confidentiality. The SQLite file is not encrypted; provider transfer ids and statuses are stored in clear.
- Availability. Anyone who can write the file can break the chain and thereby stop every flow operation
  (`AUDIT_CHAIN_BROKEN` is fail-closed by design). Recovery from a broken chain is a manual decision, not implemented.
- Non-repudiation, trusted timestamps, key management.
- The historic `AWX_SANDBOX_INTEGRATION_V1` chain. This lane never opens, copies or modifies it.

## 6. Not verified

- Behaviour inside the real flow service. The port was tested against `node:sqlite` directly and with a stand-in
  state table for the transaction test; the flow lane's code was not available to run against.
- Concurrent writers. `append` relies on the caller's transaction for isolation.
- Durability under power loss, and large chains (`verify` reads every row on every call).
- The checkpoint being wired to `DB_INTEGRATED_AUDIT_CHECKPOINT_FILE`; that wiring belongs to the integrator.
- Independent review. The author of the code wrote the tests.
