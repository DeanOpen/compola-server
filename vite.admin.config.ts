import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import { writeFileSync } from "node:fs";
// @ts-expect-error type error without @types/node package
import { fileURLToPath } from "node:url";

// Admin console of Compola Server (docs/compola-server.md), served by the host at /admin/.
// `npm run dev:admin` (add ?mock=1 to work without the Rust server), `npm run build:admin`.

const outDir = fileURLToPath(new URL("./src-tauri/admin-dist", import.meta.url));

// emptyOutDir wipes the folder, including the .gitkeep that keeps it in git (the Rust side embeds it).
function keepGitkeep(): Plugin {
  return {
    name: "compola-admin-gitkeep",
    apply: "build",
    closeBundle() {
      writeFileSync(`${outDir}/.gitkeep`, "");
    },
  };
}

const target = "http://127.0.0.1:39218";

export default defineConfig({
  root: fileURLToPath(new URL("./admin", import.meta.url)),
  base: "/admin/",
  plugins: [react(), keepGitkeep()],
  clearScreen: false,
  build: {
    outDir,
    emptyOutDir: true,
  },
  server: {
    port: 1430,
    strictPort: true,
    proxy: {
      "/api": { target, changeOrigin: false },
      "/info": { target, changeOrigin: false },
    },
  },
});
