import { mkdir, writeFile, glob, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defineBuildConfig } from "obuild/config";

const adapters = ["bun", "bunny", "cloudflare", "deno", "node", "sse", "uws"];

const servers = ["bun", "bunny", "cloudflare", "default", "deno", "node"];

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: [
        "src/index.ts",
        "src/websocket/native.ts",
        "src/websocket/node.ts",
        "src/websocket/sse.ts",
        ...adapters.map((id) => `src/adapters/${id}.ts`),
        ...servers.map((id) => `src/server/${id}.ts`),
      ],
      rolldown: {
        external: [
          "@cloudflare/workers-types",
          "bun",
          "@deno/types",
          "uWebSockets.js",
          "cloudflare:workers",
        ],
      },
    },
  ],
  hooks: {
    async end(ctx) {
      // Generate declaration files for each entry point (old TS compatibility)
      const entries = Object.keys(ctx.pkg.exports || {})
        .filter((key) => key.startsWith("./"))
        .map((key) => key.slice(2));
      for (const entry of entries) {
        const dst = join(ctx.pkgDir, entry + ".d.ts");
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
