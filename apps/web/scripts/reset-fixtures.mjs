import { readFile, rename, writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

for (const id of ["s0", "s1"]) {
  const sourcePath = new URL(`../fixtures/canonical/${id}.json`, import.meta.url);
  const targetPath = new URL(`../fixtures/${id}.json`, import.meta.url);
  const temporaryPath = new URL(`../fixtures/.${id}.json.reset.tmp`, import.meta.url);
  const bytes = await readFile(sourcePath);
  const fixture = JSON.parse(bytes.toString("utf8"));
  if (fixture.provenance !== "SYNTHETIC_FIXTURE" || fixture.scenarioId !== id.toUpperCase()) {
    throw new Error(`Refusing invalid canonical fixture ${id}`);
  }
  await writeFile(temporaryPath, bytes, { flag: "w" });
  try {
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

console.log(`Fixture reset complete from ${root}fixtures/canonical (S0, S1).`);
