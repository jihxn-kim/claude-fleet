import { createServer as httpCreate, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import type { DecisionStore } from "./decisionStore.js";
import type { DecisionRequest, DecisionAnswer } from "./types.js";

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  const payload = type === "application/json" ? JSON.stringify(body) : String(body);
  res.writeHead(status, { "content-type": type });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
};

export function createServer(
  store: DecisionStore,
  opts: { panelToken: string; publicDir: string },
): Server {
  return httpCreate(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";

      // --- 세션용 내부 엔드포인트: 롱폴링 ---
      if (path === "/internal/decisions" && method === "POST") {
        const sessionToken = String(req.headers["x-fleet-session"] ?? "session-1");
        const request = (await readJson(req)) as DecisionRequest;
        const { answer } = store.create(sessionToken, request);
        const result = await answer; // 패널이 답할 때까지 보류
        return send(res, 200, result);
      }

      // --- 패널 API: 토큰 가드 ---
      if (path.startsWith("/api/")) {
        const token = url.searchParams.get("token") ?? req.headers["x-fleet-token"];
        if (token !== opts.panelToken) return send(res, 401, { error: "bad token" });

        if (path === "/api/decisions" && method === "GET") {
          return send(res, 200, store.list());
        }
        const m = path.match(/^\/api\/decisions\/([^/]+)\/answer$/);
        if (m && method === "POST") {
          const ans = (await readJson(req)) as DecisionAnswer;
          const ok = store.answer(m[1], ans);
          return send(res, ok ? 200 : 404, { ok });
        }
        return send(res, 404, { error: "not found" });
      }

      // --- 정적 패널 ---
      if (method === "GET") {
        const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
        const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
        const file = join(opts.publicDir, safe);
        try {
          const buf = await readFile(file);
          const ext = safe.slice(safe.lastIndexOf("."));
          res.writeHead(200, { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
          return res.end(buf);
        } catch {
          return send(res, 404, "not found", "text/plain");
        }
      }

      return send(res, 405, { error: "method not allowed" });
    } catch (err) {
      send(res, 500, { error: String(err) });
    }
  });
}
