import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defineBuildConfig } from "unbuild";

export default defineBuildConfig({
  rollup: {
    inlineDependencies: true,
  },
  externals: ["@cloudflare/workers-types", "bun", "@deno/types", "uWebSockets.js"],
  hooks: {
    async "build:done"(ctx) {
      const entries = Object.keys(ctx.pkg.exports || {})
        .filter((key) => key.startsWith("./"))
        .map((key) => key.slice(2));
      for (const entry of entries) {
        const dst = join(ctx.options.rootDir, entry + ".d.ts");
        console.log(">", dst);
        await mkdir(dirname(dst), { recursive: true });
        const relativePath =
          ("..".repeat(entry.split("/").length - 1) || ".") + `/dist/${entry}`;
        await writeFile(
          dst,
          `export * from "${relativePath}";\nexport { default } from "${relativePath}";\n`,
          "utf8",
        );
      }
    },
  },
});
