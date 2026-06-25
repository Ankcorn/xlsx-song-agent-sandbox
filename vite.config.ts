import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [cloudflare(), tailwindcss(), react()],
  resolve: {
    alias: {
      turndown: "turndown/lib/turndown.browser.es.js",
    },
  },
});
