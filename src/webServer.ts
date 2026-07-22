import { createServer as httpCreate, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import type { DecisionStore } from "./decisionStore.js";
import type { SessionManager } from "./sessionManager.js";
import { HttpError } from "./sessionManager.js";
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

function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
};

export function createServer(
  store: DecisionStore,
  opts: { panelToken: string; publicDir: string; sessions?: SessionManager },
): Server {
  const sessions = opts.sessions;
  const notices = new Map<string, { message: string; at: string }>();

  function enrichDecisions(): unknown[] {
    const list = store.list();
    if (!sessions) return list;
    return list.map((d) => {
      const s = sessions.store.getSession(d.sessionToken);
      return { ...d, session: s ? { project: s.project, tmuxName: s.tmuxName, label: s.label } : null };
    });
  }
  function enrichSessions(): unknown[] {
    if (!sessions) return [];
    return sessions.store.listSessions().map((s) => ({ ...s, notice: notices.get(s.id) ?? null }));
  }
  function sendHttpError(res: ServerResponse, err: unknown): void {
    if (err instanceof HttpError) send(res, err.status, { error: err.message });
    else send(res, 500, { error: String(err) });
  }

  return httpCreate(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (path === "/internal/decisions" && method === "POST") {
        if (!isLoopback(req)) return send(res, 403, { error: "loopback only" });
        const sessionToken = String(req.headers["x-fleet-session"] ?? "session-1");
        const request = (await readJson(req)) as DecisionRequest;
        const { id, answer } = store.create(sessionToken, request);
        notices.delete(sessionToken); // session is actively asking → not "stuck"
        res.on("close", () => store.abort(id));
        try {
          const result = await answer;
          if (!res.writableEnded && !res.destroyed) return send(res, 200, result);
          return;
        } catch {
          return;
        }
      }

      if (path === "/internal/notify" && method === "POST") {
        if (!isLoopback(req)) return send(res, 403, { error: "loopback only" });
        const body = (await readJson(req)) as { sessionId: string; message: string };
        notices.set(body.sessionId, { message: body.message, at: new Date().toISOString() });
        return send(res, 200, { ok: true });
      }

      if (path.startsWith("/api/")) {
        const token = url.searchParams.get("token") ?? req.headers["x-fleet-token"];
        if (token !== opts.panelToken) return send(res, 401, { error: "bad token" });

        if (path === "/api/decisions" && method === "GET") return send(res, 200, enrichDecisions());
        const am = path.match(/^\/api\/decisions\/([^/]+)\/answer$/);
        if (am && method === "POST") {
          const ans = (await readJson(req)) as DecisionAnswer;
          const ok = store.answer(am[1], ans);
          return send(res, ok ? 200 : 404, { ok });
        }

        if (path === "/api/projects" && method === "GET") return send(res, 200, sessions?.store.listProjects() ?? []);
        if (path === "/api/projects" && method === "POST") {
          if (!sessions) return send(res, 404, { error: "sessions disabled" });
          const { name, path: p } = (await readJson(req)) as { name: string; path: string };
          sessions.store.addProject(name, p);
          return send(res, 200, { ok: true });
        }
        if (path === "/api/sessions" && method === "GET") return send(res, 200, enrichSessions());
        if (path === "/api/sessions" && method === "POST") {
          if (!sessions) return send(res, 404, { error: "sessions disabled" });
          try {
            const { project } = (await readJson(req)) as { project: string };
            return send(res, 201, sessions.launch(project));
          } catch (e) {
            return sendHttpError(res, e);
          }
        }
        const avail = path.match(/^\/api\/projects\/([^/]+)\/available$/);
        if (avail && method === "GET") {
          if (!sessions) return send(res, 404, { error: "sessions disabled" });
          try {
            return send(res, 200, sessions.discover(decodeURIComponent(avail[1])));
          } catch (e) {
            return sendHttpError(res, e);
          }
        }
        if (path === "/api/all-sessions" && method === "GET") {
          if (!sessions) return send(res, 404, { error: "sessions disabled" });
          try {
            return send(res, 200, sessions.scanRecent());
          } catch (e) {
            return sendHttpError(res, e);
          }
        }
        if (path === "/api/terminals" && method === "GET") {
          if (!sessions) return send(res, 404, { error: "sessions disabled" });
          return send(res, 200, { detected: sessions.detectTerminals(), current: sessions.getTerminal() });
        }
        if (path === "/api/terminal" && method === "POST") {
          if (!sessions) return send(res, 404, { error: "sessions disabled" });
          const { terminal } = (await readJson(req)) as { terminal: string };
          sessions.setTerminal(terminal);
          return send(res, 200, { ok: true });
        }
        if (path === "/api/permission-mode" && method === "GET") {
          if (!sessions) return send(res, 404, { error: "sessions disabled" });
          return send(res, 200, { current: sessions.getPermissionMode() });
        }
        if (path === "/api/permission-mode" && method === "POST") {
          if (!sessions) return send(res, 404, { error: "sessions disabled" });
          const { mode } = (await readJson(req)) as { mode: string };
          sessions.setPermissionMode(mode);
          return send(res, 200, { ok: true });
        }
        if (path === "/api/sessions/adopt" && method === "POST") {
          if (!sessions) return send(res, 404, { error: "sessions disabled" });
          try {
            const body = (await readJson(req)) as { id: string; project?: string; projectPath?: string };
            const entry = body.projectPath
              ? sessions.adoptByPath(body.id, body.projectPath)
              : sessions.adopt(body.id, body.project as string);
            return send(res, 201, entry);
          } catch (e) {
            return sendHttpError(res, e);
          }
        }
        const sm = path.match(/^\/api\/sessions\/([^/]+)\/(resume|close|open-terminal|label)$/);
        if (sm && method === "POST") {
          if (!sessions) return send(res, 404, { error: "sessions disabled" });
          try {
            const id = sm[1];
            if (sm[2] === "resume") return send(res, 200, sessions.resume(id));
            if (sm[2] === "close") return send(res, 200, sessions.close(id));
            if (sm[2] === "label") {
              const { label } = (await readJson(req)) as { label: string };
              return send(res, 200, sessions.setLabel(id, label));
            }
            sessions.openTerminal(id);
            return send(res, 200, { ok: true });
          } catch (e) {
            return sendHttpError(res, e);
          }
        }

        return send(res, 404, { error: "not found" });
      }

      // --- 정적 패널 (Phase 1과 동일) ---
      if (method === "GET") {
        const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
        const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
        const file = join(opts.publicDir, safe);
        try {
          const buf = await readFile(file);
          const ext = safe.slice(safe.lastIndexOf("."));
          // no-cache: the panel is iterated live, so browsers must re-fetch
          res.writeHead(200, { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream", "cache-control": "no-cache" });
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
