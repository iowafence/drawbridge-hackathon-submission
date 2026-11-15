// Prints the DRAWBRIDGE_OPERATOR_SCRYPT line for an operator passphrase (12+ characters).
// Run it yourself in a terminal: the passphrase is read without echo and is never written anywhere.
//   node scripts/operator-hash.mjs
import { randomBytes, scryptSync } from "node:crypto";

if (!process.stdin.isTTY) {
  console.error("Run this in an interactive terminal so the passphrase is not stored in shell history or a pipe.");
  process.exit(2);
}
process.stderr.write("Operator passphrase (12+ characters, not shown): ");
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
let pass = "";
process.stdin.on("data", (ch) => {
  for (const c of ch) {
    if (c === "\r" || c === "\n") {
      process.stdin.setRawMode(false);
      process.stderr.write("\n");
      if (pass.length < 12) {
        console.error("Too short.");
        process.exit(2);
      }
      const salt = randomBytes(16);
      const hash = scryptSync(pass, salt, 32, { N: 16384, r: 8, p: 1 });
      console.log(`DRAWBRIDGE_OPERATOR_SCRYPT=scrypt:16384:8:1:${salt.toString("base64")}:${hash.toString("base64")}`);
      process.exit(0);
    } else if (c === "\u0003") process.exit(130);
    else if (c === "\u007f") pass = pass.slice(0, -1);
    else pass += c;
  }
});
