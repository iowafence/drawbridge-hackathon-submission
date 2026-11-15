// SIM-ENG-002-E1 / D4 — read-only capital eligibility screen over ANVIL-2's sealed evidence JSON.
// Everything shown is derived on screen from the evidence fixture. Nothing here computes eligibility,
// approves, reserves, releases or sends anything. Synthetic, non-operational demonstration.
import evidence from "../../../fixtures/eligibility_evidence_v1.json" with { type: "json" };
import { Figure, Pill } from "../../components/Figure.tsx";
import { Shell } from "../../components/Shell.tsx";
import { formatMoney } from "../../contract/money.ts";
import { loadScenario } from "../../data/load.ts";
import type { SearchParams } from "../../data/load.ts";

export const EVIDENCE_SCHEMA = "drawbridge.sim-eng-002-e1.demo-eligibility-evidence.v1";
export const STATES = ["ALLOWED", "BLOCKED", "UNRESOLVED"] as const;
export type State = (typeof STATES)[number];
export const UNAVAILABLE = "Unavailable (invalid input)";

export const STATE_MEANING: Record<State, string> = {
  ALLOWED: "Eligible under the demonstrated rules. Not a payment authorization, not an approval, not a release.",
  BLOCKED: "Ineligible under at least one applicable deterministic rule.",
  UNRESOLVED: "Required information is missing, invalid or inconclusive. No default was applied.",
};

export interface DecisionRow {
  decisionId: string;
  requestId: string;
  state: State;
  amountMinor: bigint | null;
  amountText: string;
  approvalStatus: string;
  basis: string;
  decidingRule: string;
  ruleIds: string[];
  faults: { code: string; field: string }[];
  evidenceSha256: string;
  manifestSha256: string;
  inputSha256: { path: string; sha256: string }[];
  measures: { key: string; value: bigint | null }[];
}

export interface EligibilityView {
  schema: string;
  task: string;
  synthetic: boolean;
  nonOperational: boolean;
  manifestSha256: string;
  project: {
    id: string;
    currency: string;
    allocationMinor: bigint;
    reservesMinor: bigint;
    holdsMinor: bigint;
    reserves: { id: string; amountMinor: bigint }[];
    holds: { id: string; obligationId: string; amountMinor: bigint; status: string }[];
    availabilityInitial: bigint;
    availabilityFinal: bigint;
    holdBasis: string;
  };
  reconciliation: {
    requestedTotalMinor: bigint;
    statedTotalMinor: bigint;
    requestedTotalDeltaMinor: bigint;
    allocationDeltaMinor: bigint;
    countDelta: bigint;
    invalidAmountCount: bigint;
    allowedMinor: bigint;
    remainingAvailableMinor: bigint;
    status: "RECONCILED" | "NOT RECONCILED";
  };
  counts: Record<State, number>;
  total: number;
  groups: Record<State, DecisionRow[]>;
  inputs: { path: string; role: string; sha256: string }[];
  releaseBoundary: { operation: string; movesFunds: boolean; events: string[] };
}

type Obj = Record<string, unknown>;

function obj(v: unknown, path: string): Obj {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error(`${path}: expected object`);
  return v as Obj;
}
function str(v: unknown, path: string): string {
  if (typeof v !== "string") throw new Error(`${path}: expected string`);
  return v;
}
function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${path}: expected array`);
  return v;
}
function intMinor(v: unknown, path: string): bigint {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new Error(`${path}: expected integer minor units`);
  return BigInt(v);
}
/** A minor-unit amount that may legitimately be absent. Anything that is not a safe integer is null, never 0. */
export function optionalMinor(v: unknown): bigint | null {
  return typeof v === "number" && Number.isSafeInteger(v) ? BigInt(v) : null;
}
/** Money text for display. A null or invalid amount is never rendered as $0.00. */
export function amountText(minor: bigint | null): string {
  return minor === null ? UNAVAILABLE : formatMoney(minor);
}
function isState(v: unknown): v is State {
  return typeof v === "string" && (STATES as readonly string[]).includes(v);
}

/** Builds the screen's view model from the raw evidence JSON, validating shape, schema and count agreement. */
export function buildView(raw: unknown): EligibilityView {
  const e = obj(raw, "evidence");
  const schema = str(e.schema, "schema");
  if (schema !== EVIDENCE_SCHEMA) throw new Error(`schema mismatch: ${schema}`);
  if (e.synthetic !== true) throw new Error("evidence is not marked synthetic");
  if (e.non_operational !== true) throw new Error("evidence is not marked non_operational");

  const p = obj(e.project, "project");
  const reserves = arr(p.reserves, "project.reserves").map((r, i) => {
    const o = obj(r, `project.reserves[${i}]`);
    return { id: str(o.reserve_id, "reserve_id"), amountMinor: intMinor(o.amount_minor, "reserve amount") };
  });
  const holds = arr(p.holds, "project.holds").map((h, i) => {
    const o = obj(h, `project.holds[${i}]`);
    return {
      id: str(o.attempt_id, "attempt_id"),
      obligationId: str(o.obligation_id, "obligation_id"),
      amountMinor: intMinor(o.amount_minor, "hold amount"),
      status: str(o.status, "hold status"),
    };
  });
  const ai = obj(p.availability_initial, "availability_initial");
  const af = obj(p.availability_final, "availability_final");
  const rc = obj(e.reconciliation, "reconciliation");

  const decisions = arr(e.decisions, "decisions").map((d, i): DecisionRow => {
    const o = obj(d, `decisions[${i}]`);
    const state = o.state;
    if (!isState(state)) throw new Error(`decisions[${i}]: unknown state ${String(state)}`);
    const facts = obj(o.facts, `decisions[${i}].facts`);
    const measures = obj(o.measures, `decisions[${i}].measures`);
    const ruleIds = arr(o.rule_ids, `decisions[${i}].rule_ids`).map((r, j) => str(r, `rule_ids[${j}]`));
    if (ruleIds.length === 0) throw new Error(`decisions[${i}]: no rule ids`);
    const amountMinor = optionalMinor(measures.amount_minor);
    return {
      decisionId: str(o.decision_id, "decision_id"),
      requestId: str(o.request_id, "request_id"),
      state,
      amountMinor,
      amountText: amountText(amountMinor),
      approvalStatus: str(facts.approval_status, "approval_status"),
      basis: typeof facts.basis === "string" ? facts.basis : UNAVAILABLE,
      decidingRule: ruleIds[ruleIds.length - 1],
      ruleIds,
      faults: arr(facts.faults, "faults").map((f, j) => {
        const fo = obj(f, `faults[${j}]`);
        return { code: str(fo.code, "fault code"), field: str(fo.field, "fault field") };
      }),
      evidenceSha256: str(o.evidence_sha256, "evidence_sha256"),
      manifestSha256: str(o.manifest_sha256, "manifest_sha256"),
      inputSha256: Object.entries(obj(o.input_sha256, "input_sha256")).map(([path, sha]) => ({ path, sha256: str(sha, path) })),
      measures: Object.entries(measures)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, value]) => ({ key, value: optionalMinor(value) })),
    };
  });

  const ids = new Set(decisions.map((d) => d.decisionId));
  if (ids.size !== decisions.length) throw new Error("duplicate decision ids in evidence");

  const groups: Record<State, DecisionRow[]> = { ALLOWED: [], BLOCKED: [], UNRESOLVED: [] };
  for (const d of decisions) groups[d.state].push(d);
  const counts: Record<State, number> = {
    ALLOWED: groups.ALLOWED.length,
    BLOCKED: groups.BLOCKED.length,
    UNRESOLVED: groups.UNRESOLVED.length,
  };
  // The displayed counts are derived from the decisions array; the evidence's own counts block must agree.
  const stated = obj(e.counts, "counts");
  for (const s of STATES) {
    if (intMinor(stated[s], `counts.${s}`) !== BigInt(counts[s])) throw new Error(`counts.${s} disagrees with decisions`);
  }
  if (intMinor(stated.TOTAL, "counts.TOTAL") !== BigInt(decisions.length)) throw new Error("counts.TOTAL disagrees with decisions");

  const requestedTotalDeltaMinor = intMinor(rc.requested_total_delta_minor, "requested_total_delta_minor");
  const allocationDeltaMinor = intMinor(rc.allocation_delta_minor, "allocation_delta_minor");
  const countDelta = intMinor(rc.count_delta, "count_delta");
  const rb = obj(e.release_boundary, "release_boundary");

  return {
    schema,
    task: str(e.task, "task"),
    synthetic: true,
    nonOperational: true,
    manifestSha256: str(e.manifest_sha256, "manifest_sha256"),
    project: {
      id: str(p.project_id, "project_id"),
      currency: str(p.currency, "currency"),
      allocationMinor: intMinor(p.allocation_minor, "allocation_minor"),
      reservesMinor: intMinor(rc.reserves_minor, "reserves_minor"),
      holdsMinor: intMinor(rc.holds_minor, "holds_minor"),
      reserves,
      holds,
      availabilityInitial: intMinor(ai.available_to_commit, "availability_initial.available_to_commit"),
      availabilityFinal: intMinor(af.available_to_commit, "availability_final.available_to_commit"),
      holdBasis: str(p.hold_basis, "hold_basis"),
    },
    reconciliation: {
      requestedTotalMinor: intMinor(rc.requested_valid_amount_total_minor, "requested_valid_amount_total_minor"),
      statedTotalMinor: intMinor(rc.stated_total_minor, "stated_total_minor"),
      requestedTotalDeltaMinor,
      allocationDeltaMinor,
      countDelta,
      invalidAmountCount: intMinor(rc.invalid_amount_count, "invalid_amount_count"),
      allowedMinor: intMinor(rc.allowed_minor, "allowed_minor"),
      remainingAvailableMinor: intMinor(rc.remaining_available_minor, "remaining_available_minor"),
      status:
        requestedTotalDeltaMinor === 0n && allocationDeltaMinor === 0n && countDelta === 0n ? "RECONCILED" : "NOT RECONCILED",
    },
    counts,
    total: decisions.length,
    groups,
    inputs: arr(e.inputs, "inputs").map((x, i) => {
      const o = obj(x, `inputs[${i}]`);
      return { path: str(o.path, "path"), role: str(o.role, "role"), sha256: str(o.sha256, "sha256") };
    }),
    releaseBoundary: {
      operation: str(rb.operation, "operation"),
      movesFunds: rb.moves_funds === true,
      events: arr(rb.events, "events").map((x, i) => str(x, `events[${i}]`)),
    },
  };
}

const TONE: Record<State, "ok" | "danger" | "warn"> = { ALLOWED: "ok", BLOCKED: "danger", UNRESOLVED: "warn" };

/** Stable element id of a decision's evidence record on this page. Decision ids are unique per evidence document
 *  (buildView refuses duplicates), so every anchor target is unique. */
export function evidenceAnchor(decisionId: string): string {
  return `evidence-${decisionId}`;
}

/** Stable element id of a decision's row. */
export function decisionAnchor(decisionId: string): string {
  return `decision-${decisionId}`;
}

function Decision({ d }: { d: DecisionRow }) {
  const evidenceId = evidenceAnchor(d.decisionId);
  return (
    <li id={decisionAnchor(d.decisionId)} data-decision-id={d.decisionId} data-state={d.state}>
      <b>{d.requestId}</b>{" "}
      <a className="mono muted" href={`#${evidenceId}`} data-evidence-link={d.decisionId} title={`Evidence record for ${d.decisionId}`}>
        {d.decisionId}
      </a>{" "}
      <Pill tone={TONE[d.state]}>{d.state}</Pill>
      <div>
        Requested amount: <span data-amount={d.amountMinor === null ? "unavailable" : d.amountMinor.toString()}>{d.amountText}</span>
        {" · "}Basis: {d.basis}
        {" · "}Approval status: {d.approvalStatus}
      </div>
      <div>
        Primary reason — deciding rule: <span className="mono">{d.decidingRule}</span>
        {d.faults.length > 0 ? (
          <>
            {" · "}Recorded faults: {d.faults.map((f) => `${f.code} (${f.field})`).join(", ")}
          </>
        ) : null}
      </div>
      <details data-evidence-for={d.decisionId}>
        <summary>Evidence {d.evidenceSha256.slice(0, 16)}…</summary>
        {/* The link target is inside the details so that fragment navigation reveals the record. */}
        <dl className="kv" id={evidenceId} tabIndex={-1} aria-label={`Evidence record ${d.decisionId}`}>
          <dt>Decision ID</dt>
          <dd className="mono">{d.decisionId}</dd>
          <dt>Evidence SHA-256 (content hash, not a signature)</dt>
          <dd className="mono">{d.evidenceSha256}</dd>
          <dt>Rule IDs applied, in order</dt>
          <dd className="mono">{d.ruleIds.join(" → ")}</dd>
          <dt>Minor-unit measures</dt>
          <dd>
            <ul className="clean">
              {d.measures.map((m) => (
                <li key={m.key}>
                  <span className="mono">{m.key}</span>: {m.value === null ? UNAVAILABLE : `${m.value.toString()} (${formatMoney(m.value)})`}
                </li>
              ))}
            </ul>
          </dd>
          <dt>Recorded faults</dt>
          <dd>{d.faults.length === 0 ? "none" : d.faults.map((f) => `${f.code} on ${f.field}`).join("; ")}</dd>
          <dt>Pinned input references</dt>
          <dd>
            <ul className="clean">
              {d.inputSha256.map((x) => (
                <li key={x.path}>
                  <span className="mono">{x.path}</span> <span className="mono muted">{x.sha256}</span>
                </li>
              ))}
            </ul>
          </dd>
          <dt>Manifest SHA-256</dt>
          <dd className="mono">{d.manifestSha256}</dd>
        </dl>
      </details>
    </li>
  );
}

/** The accepted E1 eligibility content, unchanged in substance: it reads the sealed evidence fixture, derives the counts
 *  from the decision records and renders the three groups with their evidence anchors. Rendered inside the Incident Room
 *  Shell by the default export; exported separately so tests can render it without the shell. */
export function EligibilityContent() {
  const v = buildView(evidence);
  const m = formatMoney;
  return (
    <>
      <div className="card alert-warn" role="note" data-eligibility-note="true">
        SYNTHETIC / NON-OPERATIONAL DEMO. Synthetic project and requests; no real parties, accounts, banking transactions or
        provider connection. Read-only. ALLOWED means eligible under the demonstrated rules, not that any payment was
        authorized or released.
      </div>
      <p className="muted">
        Synthetic project {v.project.id} · {v.task} · schema {v.schema}. The eligibility evidence is one synthetic project,
        independent of the S0/S1 Incident Room scenario; the scenario switch above changes only the shell totals.
      </p>

      <section className="card" aria-labelledby="summary-h">
        <h2 id="summary-h">
          Project capital summary <Pill tone="synthetic">SYNTHETIC</Pill>
        </h2>
        <div className="grid">
          <Figure label="Project" contractKey="project_id" value={v.project.id} sub={`Currency ${v.project.currency}`} />
          <Figure label="Allocation" contractKey="allocation_minor" value={m(v.project.allocationMinor)} />
          <Figure
            label="Reserves"
            contractKey="reserves_minor"
            value={m(v.project.reservesMinor)}
            sub={v.project.reserves.map((r) => `${r.id} ${m(r.amountMinor)}`).join("; ")}
          />
          <Figure
            label="Holds"
            contractKey="holds_minor"
            value={m(v.project.holdsMinor)}
            sub={v.project.holds.map((h) => `${h.id} on ${h.obligationId} (${h.status}) ${m(h.amountMinor)}`).join("; ")}
          />
          <Figure label="Initial availability" contractKey="availability_initial.available_to_commit" value={m(v.project.availabilityInitial)} sub={`Hold basis ${v.project.holdBasis}`} />
          <Figure label="Final availability" contractKey="availability_final.available_to_commit" value={m(v.project.availabilityFinal)} tone={v.project.availabilityFinal === 0n ? "zero" : "plain"} />
          <Figure
            label="Total requested capital"
            contractKey="requested_valid_amount_total_minor"
            value={m(v.reconciliation.requestedTotalMinor)}
            sub={`Stated total ${m(v.reconciliation.statedTotalMinor)}; ${v.reconciliation.invalidAmountCount.toString()} request(s) with unavailable amounts excluded from this sum`}
          />
          <Figure
            label="Reconciliation"
            contractKey="requested_total_delta_minor / allocation_delta_minor / count_delta"
            value={v.reconciliation.status}
            sub={`deltas ${v.reconciliation.requestedTotalDeltaMinor.toString()} / ${v.reconciliation.allocationDeltaMinor.toString()} / ${v.reconciliation.countDelta.toString()}; ALLOWED total ${m(v.reconciliation.allowedMinor)}; remaining ${m(v.reconciliation.remainingAvailableMinor)}`}
          />
        </div>
      </section>

      <section className="card" aria-labelledby="results-h">
        <h2 id="results-h">Eligibility results</h2>
        <p className="muted">
          {v.total} decisions: ALLOWED <span data-count="ALLOWED">{v.counts.ALLOWED}</span>, BLOCKED{" "}
          <span data-count="BLOCKED">{v.counts.BLOCKED}</span>, UNRESOLVED <span data-count="UNRESOLVED">{v.counts.UNRESOLVED}</span>.
          Counts are derived from the decision records; the evidence file's own counts agree.
        </p>
        <div className="legend">
          {STATES.map((s) => (
            <div key={s}>
              <Pill tone={TONE[s]}>{s}</Pill> {STATE_MEANING[s]}
            </div>
          ))}
        </div>
      </section>

      {STATES.map((s) => (
        <section className="card" key={s} data-group={s} aria-labelledby={`group-${s}`}>
          <h2 id={`group-${s}`}>
            {s} <Pill tone={TONE[s]}>{v.counts[s]}</Pill>
          </h2>
          <p className="muted">{STATE_MEANING[s]}</p>
          <ul className="clean">
            {v.groups[s].map((d) => (
              <Decision key={d.decisionId} d={d} />
            ))}
          </ul>
        </section>
      ))}

      <section className="card" aria-labelledby="prov-h">
        <h2 id="prov-h">Provenance and release boundary</h2>
        <dl className="kv">
          <dt>Evidence manifest SHA-256</dt>
          <dd className="mono">{v.manifestSha256}</dd>
          <dt>Pinned inputs</dt>
          <dd>
            <ul className="clean">
              {v.inputs.map((x) => (
                <li key={x.path}>
                  <span className="mono">{x.path}</span> ({x.role}) <span className="mono muted">{x.sha256}</span>
                </li>
              ))}
            </ul>
          </dd>
          <dt>Release boundary</dt>
          <dd>
            Operation {v.releaseBoundary.operation}; moves funds: {v.releaseBoundary.movesFunds ? "yes" : "no"}; recorded event types:{" "}
            {v.releaseBoundary.events.join(", ")}. In the engine, a simulated release is recorded only for a token whose
            HMAC-SHA256 verifies against verification material held by the trusted offline test harness; the engine holds
            no key and issues no token. That check proves only that the harness issued the token: it is not cryptographic
            authorization by a real person, establishes no authenticated real-human identity, carries no production
            security guarantee and confers no actual payment authority. Everything shown is synthetic and non-operational,
            and there is no release-payment control on this screen.
          </dd>
        </dl>
      </section>

      <p className="provenance" data-eligibility-provenance="true">
        Source: the sealed SIM-ENG-002-E1 evidence JSON produced by the synthetic demo engine from pinned synthetic
        fixtures. Hashes shown are content hashes for reproduction; they are not signatures and do not establish
        independent custody. Nothing here is a payment authority, an approval, a release or a record of a real bank
        balance.
      </p>
    </>
  );
}

/** Screen 6 of the Incident Room. The eligibility evidence does not depend on the S0/S1 scenario; the scenario only
 *  drives the shared shell (scenario switch and the requested-outflow totals), exactly as on the other five screens. */
export default async function EligibilityPage({ searchParams }: { searchParams: SearchParams }) {
  const { id, d } = await loadScenario(searchParams);
  return (
    <Shell scenario={id} active="eligibility" requestedTotal={d.requestedTotal} additionalNotRequestedTotal={d.additionalNotRequestedTotal}>
      <EligibilityContent />
    </Shell>
  );
}
