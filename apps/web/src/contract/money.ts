// Exact money in integer cents (bigint). Money strings are "0.00" decimal text; floats are never used.
// Mirrors the string shape rule of contracts/money.md: no exponent, exactly two decimals.

const MONEY = /^-?(0|[1-9][0-9]{0,13})\.[0-9]{2}$/;

export type Cents = bigint;

export function parseMoney(text: string): Cents {
  if (typeof text !== "string" || !MONEY.test(text) || text === "-0.00") {
    throw new Error(`invalid money string: ${JSON.stringify(text)}`);
  }
  const negative = text.startsWith("-");
  const [whole, frac] = text.replace("-", "").split(".");
  const cents = BigInt(whole) * 100n + BigInt(frac);
  return negative ? -cents : cents;
}

export function formatMoney(cents: Cents, opts: { sign?: boolean } = {}): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % 100n).toString().padStart(2, "0");
  const body = `$${whole}.${frac}`;
  if (negative) return `−${body}`;
  return opts.sign && cents > 0n ? `+${body}` : body;
}

export function formatMoneyShort(cents: Cents): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const dollars = abs / 100n;
  let text: string;
  if (dollars >= 1_000_000n) {
    const tenths = (dollars * 10n) / 1_000_000n;
    text = `$${tenths / 10n}.${tenths % 10n}M`;
  } else if (dollars >= 1_000n) {
    text = `$${dollars / 1_000n}K`;
  } else {
    text = `$${dollars}`;
  }
  return negative ? `−${text}` : text;
}

export function sum(values: Cents[]): Cents {
  return values.reduce((a, b) => a + b, 0n);
}

export function addCents(a: Cents, b: Cents): Cents {
  return a + b;
}

export function subtractCents(a: Cents, b: Cents): Cents {
  return a - b;
}

export function compareCents(a: Cents, b: Cents): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function max0(value: Cents): Cents {
  return value > 0n ? value : 0n;
}

export function min(a: Cents, b: Cents): Cents {
  return a < b ? a : b;
}
