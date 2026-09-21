import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const backend = process.env.BACKEND_URL ?? "http://127.0.0.1:8103";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { "/api": backend, "/hooks": backend, "/sentry": backend } },
});
