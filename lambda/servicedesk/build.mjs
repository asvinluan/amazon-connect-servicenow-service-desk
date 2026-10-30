// Bundle src/handler.ts into dist/index.js, the single file Terraform zips.
//
// Written as a Node script, not a shell one-liner, so the same command works
// in Windows PowerShell, Git Bash and Linux. It also deletes dist first, so a
// file that no longer exists in src can never be shipped by accident.
import { build } from "esbuild";
import { mkdirSync, rmSync, statSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/handler.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  // The Node.js Lambda runtime already contains AWS SDK v3, so it is not
  // bundled. Everything else (Powertools) is bundled into the one file.
  external: ["@aws-sdk/*"],
  logLevel: "info",
});

const kb = (statSync("dist/index.js").size / 1024).toFixed(1);
console.log(`built dist/index.js (${kb} KB)`);
