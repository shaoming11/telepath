import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import { wasp } from "wasp/client/vite";
import type { IncomingMessage } from "node:http";

const target = new URL(
  "http://127.0.0.1:" + (process.env.TELEPATHY_PORT || "5780"),
);
const localPeers = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function allowed(request: IncomingMessage, websocket = false) {
  try {
    const browser = new URL("http://" + request.headers.host);
    if (
      !localHosts.has(browser.hostname) ||
      !localPeers.has(request.socket.remoteAddress || "")
    )
      return false;
    const origin = request.headers.origin;
    return (
      origin === browser.origin ||
      (!origin &&
        !websocket &&
        request.method === "GET" &&
        request.headers["sec-fetch-site"] !== "cross-site")
    );
  } catch {
    return false;
  }
}

function hubPolicy(): Plugin {
  return {
    name: "telepathy-local-stage",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith("/hub/") || allowed(request))
          return next();
        response.writeHead(403).end();
      });
    },
  };
}

const hubProxy: ProxyOptions = {
  target: target.origin,
  changeOrigin: true,
  ws: true,
  rewrite: (path) => path.replace(/^\/hub/, ""),
  configure(proxy) {
    proxy.on("proxyReq", (upstream, request) => {
      if (!allowed(request)) {
        upstream.destroy();
        return;
      }
      if (request.headers.origin) upstream.setHeader("Origin", target.origin);
    });
    proxy.on("proxyReqWs", (upstream, request, socket) => {
      if (
        !allowed(request, true) ||
        new URL(request.url || "/", target).searchParams.get("role") !== "stage"
      ) {
        upstream.destroy();
        socket.destroy();
        return;
      }
      upstream.setHeader("Origin", target.origin);
    });
  },
};

export default defineConfig({
  plugins: [wasp(), hubPolicy()],
  optimizeDeps: {
    include: [
      "@react-three/drei",
      "@react-three/fiber",
      "@react-three/postprocessing",
      "postprocessing",
      "three",
    ],
  },
  server: {
    host: "127.0.0.1",
    cors: false,
    proxy: {
      "^/hub/(?:ws\\?|info(?:$|\\?)|references(?:$|\\?)|assets/)": hubProxy,
    },
  },
});
