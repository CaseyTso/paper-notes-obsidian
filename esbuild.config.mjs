import esbuild from "esbuild";
import { copyFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import process from "node:process";

const production = process.argv[2] === "production";

const context = await esbuild.context({
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

if (production) {
  await context.rebuild();
  await context.dispose();
  await copyFile("src/styles.css", "styles.css");
  console.log("paper-notes-obsidian: built main.js and styles.css");
} else {
  await context.watch();
  console.log("paper-notes-obsidian: watching for changes");
}
