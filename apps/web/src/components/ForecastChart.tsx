import { formatMoney, formatMoneyShort } from "../contract/money.ts";
import type { WeekRow } from "../contract/derive.ts";

// Server-rendered SVG. Weeks without a recorded schedule are drawn as hatched, unlabeled slots and are never
// given a number. The chart shows the running balance that follows from AVAIL plus RECORDED items only.
export function ForecastChart({ weeks }: { weeks: WeekRow[] }) {
  const W = 340;
  const H = 170;
  const padL = 8;
  const padR = 8;
  const top = 18;
  const bottom = 30;
  const plotH = H - top - bottom;
  const known = weeks.filter((w) => w.runningBalance !== null).map((w) => w.runningBalance as bigint);
  const maxV = known.reduce((a, b) => (b > a ? b : a), 1n);
  const slot = (W - padL - padR) / weeks.length;
  const barW = Math.max(6, slot - 6);
  const label = `13-week forecast of the running balance. Weeks 1 to ${weeks.filter((w) => w.scheduled).length} have recorded items. Later weeks have no schedule recorded and are not estimated.`;
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label} style={{ display: "block", maxHeight: 240 }}>
        <defs>
          <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--muted)" strokeWidth="2" />
          </pattern>
        </defs>
        <line x1={padL} x2={W - padR} y1={top + plotH} y2={top + plotH} stroke="var(--border)" />
        {weeks.map((w, i) => {
          const x = padL + i * slot + (slot - barW) / 2;
          if (w.runningBalance === null) {
            return (
              <g key={w.week}>
                <rect x={x} y={top} width={barW} height={plotH} fill="url(#hatch)" opacity="0.35" rx="2" />
                <text x={x + barW / 2} y={H - 14} fontSize="8" textAnchor="middle" fill="var(--muted)">{w.week}</text>
              </g>
            );
          }
          const v = w.runningBalance;
          const h = v <= 0n ? 2 : Math.max(2, Number((v * BigInt(plotH)) / maxV));
          return (
            <g key={w.week}>
              <rect x={x} y={top + plotH - h} width={barW} height={h} fill={v < 0n ? "var(--danger)" : "var(--accent)"} rx="2">
                <title>{`Week ${w.week}: ${formatMoney(v)}`}</title>
              </rect>
              <text x={x + barW / 2} y={H - 14} fontSize="8" textAnchor="middle" fill="var(--muted)">{w.week}</text>
            </g>
          );
        })}
        <text x={padL} y={11} fontSize="9" fill="var(--muted)">Peak {formatMoneyShort(maxV)}</text>
        <text x={W - padR} y={H - 3} fontSize="8" textAnchor="end" fill="var(--muted)">week</text>
      </svg>
      <figcaption className="muted" style={{ fontSize: "0.8rem" }}>
        Starts from available capacity. Hatched weeks have no schedule recorded and are not estimated. Illustrative
        payroll items are labeled as such in the table below.
      </figcaption>
    </figure>
  );
}
