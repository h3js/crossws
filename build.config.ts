import { mkdir, writeFile, glob, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defineBuildConfig } from "unbuild";

export default defineBuildConfig({
  rollup: {
    inlineDependencies: true,
  },
  externals: [
    "@cloudflare/workers-types",
    "bun",
    "@deno/types",
    "uWebSockets.js",
    "cloudflare:workers",
  ],
  hooks: {
    async "build:done"(ctx) {
      for await (const file of glob("dist/**/*.d.ts")) {
        await rm(file);
      }

      const entries = Object.keys(ctx.pkg.exports || {})
        .filter((key) => key.startsWith("./"))
        .map((key) => key.slice(2));
      for (const entry of entries) {
        const dst = join(ctx.options.rootDir, entry + ".d.ts");
        await mkdir(dirname(dst), { recursive: true });
        let relativePath =
          ("..".repeat(entry.split("/").length - 1) || ".") + `/dist/${entry}`;
        if (entry === "websocket") {
          relativePath += "/native";
        } else if (entry === "server") {
          relativePath += "/node";
        }
        await writeFile(
          dst,
          `export * from "${relativePath}.mjs";\nexport { default } from "${relativePath}.mjs";\n`,
          "utf8",
        );
      }
    },
  },
});
