# UI redesign acceptance baseline (branch ui/erp-redesign)

Presentation-layer redesign of the Incident Room. It does not change financial authority, calculations, fixtures,
the E3 evidence components, or any database work. It is **not** the accepted E3 candidate and makes no claim of
byte-identity with it. The accepted E3 commit and its original pins stay reproducible in Git history
(`f88af200a3e76b31c1f6129bfeae04e2ca64a24a`).

## Candidate pins

`tests/ui-baseline.json` holds explicit SHA-256 pins:

- `candidate`: files the redesign deliberately changes or adds. Regenerate with `npm run ui:baseline` when one of them
  changes on purpose. `UI-B1` fails if a pinned file drifts silently.
- `preserved`: finance (`src/contract/*`), data readers, E3 components, and every fixture. They must stay
  byte-identical to the accepted E3 commit. `UI-B2` checks the pins; `UI-B3` re-checks them against Git.

`UI-B4` reproduces the four historical accepted-E3 pins (`globals.css`, `Shell.tsx`, and the two pre-E3 pages) from the
accepted commit, so the original invariant is still demonstrable.

## Superseded historical invariants (tests/cashcrisis.test.ts)

| Test | Original invariant | Why it cannot hold | Replacement |
|---|---|---|---|
| E3-AT-9.5 | `globals.css` is the accepted file | The shell and Command screen add styles | `globals.css` equals its candidate pin. The class-existence and 375px table checks are unchanged |
| E3-AT-10.1 | Each page is the accepted page plus three added lines; Shell unchanged | Overview was rebuilt; Shell restyled | E3 component wired exactly once per page; candidate pins; preserved pins |
| E3-AT-10.2 | Page = pre-E3 page with the E3 section appended before the footer | On Command the section is the last child of the collapsed "Full evidence" expander, and Command panels follow the funding case | Page = same page without the E3 section, with the section inserted at its one insertion point, per scenario and case |
| E3-AT-10.3 and shell tests | Screen 1 is "Overview / Treasury overview" | Renamed Command (route `/overview` unchanged) | Same assertions with the new name |

All other E3 assertions (data reader, financial figures, disclosures, accessibility structure, boundary checks) run
unchanged. The only other edit to `cashcrisis.test.ts` is a two-line harness wiring that loads `Command.tsx`.

## Command behavior tests

`tests/command.test.ts` covers: route and name, answer banner ($1,300,000.00 week-two gap, delayed; no gap, on time;
ready to send $0.00), toggle links, six-step tour links, no enabled controls or scripts, S1 spending-blocked warning,
request rules and statuses, the six events and hashes, four bounded agent notes, wallet disclosure, incomplete-week
hatching, and the collapsed full evidence.

## Incident screen

`src/app/incident/page.tsx` and `src/components/IncidentRoom.tsx` join the candidate pins. The accepted E3 incident
component (`CashCrisisIncident.tsx`) is unchanged and renders as the last child of the page's "Full evidence" expander.
The re-based E3-AT-10.1 and 10.2 cover both screens. `tests/incident.test.ts` covers status and trigger, case links,
stopped commitments with rules and evidence, operational effects, bounded agent findings, the six-event history, no
controls, the S1 allocation-wide alert, and the collapsed full evidence. `tests/ui_harness.ts` is the shared render helper.

## Recorder screen

`src/app/recorder/page.tsx` and `src/components/RecorderView.tsx` join the candidate pins. Event content, digests and
evidence identifiers are displayed exactly as the snapshot records them. The only check the screen makes is that each
event's recorded predecessor digest equals the previous event's recorded digest. It does not recompute digests (the test
suite does, in E3-W6) and it makes no claim of an external anchor. `tests/recorder.test.ts` compares every displayed digest,
title, finding, role, date and evidence id with the fixture.

## Payables screen

`src/app/payables/page.tsx` and `src/components/PayablesView.tsx` join the candidate pins. Obligation figures are the
derived scenario values already shown before; rules, approval dependencies and evidence (with its status, so gaps are
visible) come from the E3 snapshot. No payment total is invented (`PAY-1` asserts that no all-obligation total appears)
and no control exists. `tests/payables.test.ts` compares each obligation's label, eligibility, reason and evidence with the fixtures.
