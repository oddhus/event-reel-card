import { defineConfig, loadEnv } from "vite";
import type { IncomingMessage } from "node:http";
import type { ProxyOptions } from "vite";

// Dev harness: serves dev/index.html with a mock `hass`. Frigate media paths are proxied
// the way the HA Frigate integration would, against FRIGATE_URL from .env.local.
// Only pages opened with ?live=1 reach Frigate: the example data uses camera names a real
// Frigate may also have, and its screenshots must never show real footage.
const fromLivePage = (req: IncomingMessage) => {
  try {
    return new URL(req.headers.referer ?? "").searchParams.get("live") === "1";
  } catch {
    return false;
  }
};
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const frigate = env.FRIGATE_URL?.replace(/\/$/, "");

  const proxy: Record<string, ProxyOptions> = {};
  if (frigate) {
    const route = (from: RegExp, to: string): ProxyOptions => ({
      target: frigate,
      changeOrigin: true,
      rewrite: (path) => path.replace(from, to),
      // false answers 404 instead of proxying.
      bypass: (req) => (fromLivePage(req) ? undefined : false),
    });
    proxy["^/api/frigate/[^/]+/vod/.*"] = route(/^\/api\/frigate\/[^/]+\/vod\//, "/vod/");
    proxy["^/api/frigate/[^/]+/clips/.*"] = route(/^\/api\/frigate\/[^/]+\/clips\//, "/clips/");
    proxy["^/api/frigate/[^/]+/notifications/[^/]+/review_preview[.]gif.*"] = route(
      /^\/api\/frigate\/[^/]+\/notifications\/([^/]+)\/review_preview\.gif/,
      "/api/review/$1/preview",
    );
    proxy["^/api/frigate/[^/]+/recording/.*"] = route(
      /^\/api\/frigate\/[^/]+\/recording\/([^/]+)\/start\/([.0-9]+)\/end\/([.0-9]+).*/,
      "/api/$1/start/$2/end/$3/clip.mp4",
    );
    proxy["^/api/frigate/[^/]+/preview/.*"] = route(
      /^\/api\/frigate\/[^/]+\/preview\/([^/]+)\/start\/([.0-9]+)\/end\/([.0-9]+).*/,
      "/api/$1/start/$2/end/$3/preview.mp4",
    );
    proxy["^/frigate-api/.*"] = route(/^\/frigate-api\//, "/api/");
  }

  return {
    root: "dev",
    envDir: process.cwd(),
    define: { __VERSION__: JSON.stringify("dev") },
    server: { port: 5173, proxy },
  };
});
