import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // src-tauri/target must stay out of the watcher: while cargo writes there the
  // file handles are locked and chokidar dies with EBUSY, killing the dev server.
  server: { host: "127.0.0.1", port: 1433, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "es2021", sourcemap: false },
});
