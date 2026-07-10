import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  // Shebang so the published `zkao` bin is directly executable.
  banner: { js: "#!/usr/bin/env node" },
});
