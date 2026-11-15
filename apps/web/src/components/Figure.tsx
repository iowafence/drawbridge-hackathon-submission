import type { ReactNode } from "react";

export function Figure(props: {
  label: string;
  contractKey: string;
  value: string;
  sub?: ReactNode;
  tone?: "neg" | "zero" | "plain";
}) {
  return (
    <section className={`card figure ${props.tone ?? "plain"}`}>
      <div className="label">{props.label}</div>
      <div className="key">{props.contractKey}</div>
      <div className="value">{props.value}</div>
      {props.sub ? <div className="sub">{props.sub}</div> : null}
    </section>
  );
}

export function Pill(props: { tone?: "ok" | "warn" | "danger" | "synthetic" | "plain"; children: ReactNode }) {
  return <span className={`pill ${props.tone && props.tone !== "plain" ? props.tone : ""}`}>{props.children}</span>;
}
