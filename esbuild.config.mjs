import esbuild from "esbuild";
import process from "node:process";
import builtins from "builtin-modules";

const production = process.argv.includes("production");

const context = await esbuild.context({
  bundle: true,
  entryPoints: ["main.ts"],
  external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view", ...builtins],
  format: "cjs",
  logLevel: "info",
  outfile: "main.js",
  platform: "node",
  sourcemap: production ? false : "inline",
  target: "es2020",
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
