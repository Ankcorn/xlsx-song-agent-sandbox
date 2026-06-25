import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [cloudflare(), react()],
  resolve: {
    alias: {
      turndown: "turndown/lib/turndown.browser.es.js",
    },
  },
});
