import { defineConfig } from "vite";
import { wasp } from "wasp/client/vite";

// The hub only accepts the stage socket from a loopback peer whose Origin matches its Host,
// so the dev server forwards /hub/* to it and presents the hub's own origin.
const hub = process.env.TELEPATHY_HUB_URL ?? "http://localhost:5780";

export default defineConfig({
  plugins: [wasp()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/hub": {
        target: hub,
        ws: true,
        secure: false,
        changeOrigin: true,
        headers: { origin: hub },
        rewrite: path => path.replace(/^\/hub/, ""),
      },
    },
  },
});
