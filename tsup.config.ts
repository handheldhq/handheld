import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { cli: "src/cli.ts", "route-cli": "src/route-cli.ts" },
    format: ["esm"],
    target: "node18",
    clean: true,
    splitting: false,
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    target: "node18",
    dts: true,
    splitting: true,
  },
  {
    entry: {
      "transport/relay/daemon": "src/transport/relay/daemon.ts",
    },
    format: ["esm"],
    target: "node18",
    splitting: false,
  },
]);
