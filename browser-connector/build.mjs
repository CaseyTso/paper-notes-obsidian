import { build } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: {
    popup: join(root, "src", "popup.ts"),
    extract: join(root, "src", "extract.ts"),
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome110",
  outdir: dist,
  sourcemap: false,
  minify: false,
  logLevel: "info",
});

for (const file of ["popup.html", "popup.css", "manifest.json"]) {
  await copyFile(join(root, "src", file), join(dist, file));
}

console.log("paper-notes-browser-connector: built dist/");
