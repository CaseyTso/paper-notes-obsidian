import esbuild from "esbuild";
import { copyFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import process from "node:process";

const production = process.argv[2] === "production";

// Desktop plugin (`paper-notes`, `isDesktopOnly: true`): unchanged — Node
// platform, node builtins external, every managed write routed through the
// paper-notes CLI.
const desktopContext = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
  ],
  format: "cjs",
  logLevel: "info",
  minify: production,
  outfile: "main.js",
  platform: "node",
  sourcemap: production ? false : "inline",
  target: "node20",
  treeShaking: true,
});

// Mobile companion plugin (`paper-notes-mobile`, ADR 0006/0007): a separate
// bundle sharing only the pure `src/shared/` layer. It imports `obsidian` and
// nothing else external — no node builtins, no electron, no codemirror — so
// it can load inside Obsidian Mobile.
const mobileContext = await esbuild.context({
  entryPoints: ["mobile/src/main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  logLevel: "info",
  minify: production,
  outfile: "mobile/main.js",
  platform: "browser",
  sourcemap: production ? false : "inline",
  target: "es2020",
  treeShaking: true,
});

if (production) {
  await desktopContext.rebuild();
  await desktopContext.dispose();
  await mobileContext.rebuild();
  await mobileContext.dispose();
  await copyFile("src/styles.css", "styles.css");
  console.log("paper-notes-obsidian: built main.js, mobile/main.js and styles.css");
} else {
  await Promise.all([desktopContext.watch(), mobileContext.watch()]);
  console.log("paper-notes-obsidian: watching for changes (desktop + mobile)");
}
