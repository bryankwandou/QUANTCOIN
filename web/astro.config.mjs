import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://quantcoin-pi.vercel.app",
  trailingSlash: "always",
  build: { format: "directory" },
});
