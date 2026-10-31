/**
 * Build the published package: an ESM bundle per public entry in dist/, sharing chunks so every entry sees
 * the same classes (an error thrown by the transport is `instanceof` the one `@bloxwap/hyperevm` exports),
 * and declarations in dist/types. Declarations keep the sources' `.ts` specifiers, so they are rewritten to
 * `.js`, which TypeScript resolves to the `.d.ts` beside it.
 * @module
 */

import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const packageRoot = new URL("../../", import.meta.url).pathname;
const dist = join(packageRoot, "dist");

await rm(dist, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["src/mod.ts", "src/transport/mod.ts", "src/registry/mod.ts"].map((entry) => join(packageRoot, entry)),
  root: join(packageRoot, "src"),
  outdir: dist,
  format: "esm",
  target: "node",
  splitting: true,
  sourcemap: "external",
  external: ["viem"],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const tsc = Bun.spawnSync(["bunx", "tsc", "--project", "tsconfig.build.json"], {
  cwd: packageRoot,
  stdio: ["inherit", "inherit", "inherit"],
});
if (tsc.exitCode !== 0) process.exit(tsc.exitCode ?? 1);

const types = join(dist, "types");
let declarations = 0;
for (const file of await readdir(types, { recursive: true })) {
  if (!file.endsWith(".d.ts")) continue;
  const path = join(types, file);
  const source = await readFile(path, "utf8");
  await writeFile(path, source.replace(/(from\s+|import\()(["'])(\.{1,2}\/[^"']+)\.ts\2/g, "$1$2$3.js$2"));
  declarations += 1;
}

console.log(`Built ${result.outputs.length} file(s) and ${declarations} declaration(s) to dist/.`);

export {};
