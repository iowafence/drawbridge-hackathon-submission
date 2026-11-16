// Network guard for the integrated-flow tests. TEST CODE ONLY.
// Importing this module replaces every ordinary way out of the process (global fetch, TCP/TLS sockets, DNS lookup)
// with a function that records the attempt and fails. A test file asserts afterwards that nothing was recorded.
// Attempts are also appended to DBIT_NET_LOG when it is set, so a parent can see what a child process tried.
import { appendFileSync } from "node:fs";
import dns from "node:dns";
import net from "node:net";

const attempts: string[] = [];
function record(what: string): Error {
  attempts.push(what);
  if (process.env.DBIT_NET_LOG) {
    try {
      appendFileSync(process.env.DBIT_NET_LOG, what + "\n");
    } catch {
      // the in-memory record is still authoritative for this process
    }
  }
  return new Error(`NETWORK_BLOCKED_IN_TESTS ${what}`);
}

globalThis.fetch = (async (input: unknown) => {
  throw record(`fetch ${String(input instanceof Request ? input.url : input).slice(0, 120)}`);
}) as typeof fetch;

net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  // net.connect() hands over one pre-normalised [options, callback] array; a direct call passes the options first
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  const o = first as { host?: string; port?: number; path?: string } | number | string;
  const where = typeof o === "object" && o !== null ? (o.path ?? `${o.host ?? "localhost"}:${o.port}`) : String(o);
  const err = record(`socket ${where}`);
  process.nextTick(() => this.destroy(err));
  return this;
} as typeof net.Socket.prototype.connect;

dns.lookup = ((host: string, ...rest: unknown[]) => {
  const cb = rest.at(-1);
  const err = record(`dns ${host}`);
  if (typeof cb === "function") process.nextTick(() => (cb as (e: Error) => void)(err));
}) as unknown as typeof dns.lookup;

export const networkAttempts = (): readonly string[] => attempts;
