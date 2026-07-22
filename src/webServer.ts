import { createServer as httpCreate, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join, normalize } from "node:path";
import qrcode from "qrcode-generator";
import type { SessionManager } from "./sessionManager.js";
import { HttpError } from "./sessionManager.js";

// The phone reaches the panel over Tailscale, so the QR must encode the Tailscale IP —
// not localhost/the LAN IP. Tailscale hands each node an address in the CGNAT range
// 100.64.0.0/10 (second octet 64–127) on a utun interface; read it straight off the
// interface list. This is pure Node — no dependency on the `tailscale` CLI, which a
// launchd process can't reliably exec.
function tailscaleIp(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const [o1, o2] = a.address.split(".").map(Number);
      if (o1 === 100 && o2 >= 64 && o2 <= 127) return a.address;
    }
  }
  return null;
}

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
  opts: { panelToken: string; publicDir: string; sessions?: SessionManager; port?: number },
): Server {
  const sessions = opts.sessions;
  const port = opts.port ?? 4179;

  function enrichSessions(): unknown[] {
    if (!sessions) return [];
    const activity = sessions.sessionActivity();
    return sessions.store.listSessions().map((s) => ({
      ...s,
      activity: activity[s.id] ?? null,
      terminalOpen: sessions.terminalOpen(s.id),
      remoteActive: sessions.remoteActive(s.id),
      prompt: sessions.sessionPrompt(s.id),
    }));
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

      if (path.startsWith("/api/")) {
        const token = url.searchParams.get("token") ?? req.headers["x-fleet-token"];
        if (token !== opts.panelToken) return send(res, 401, { error: "bad token" });

        if (path === "/api/panel-url" && method === "GET") {
          const ip = tailscaleIp();
          const host = ip ?? (req.headers.host?.split(":")[0] || "127.0.0.1");
          const panelUrl = `http://${host}:${port}/?token=${opts.panelToken}`;
          const qr = qrcode(0, "M");
          qr.addData(panelUrl);
          qr.make();
          const svg = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
          return send(res, 200, { url: panelUrl, host, port, viaTailscale: !!ip, svg });
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
        const pa = path.match(/^\/api\/sessions\/([^/]+)\/prompt-answer$/);
        if (pa && method === "POST") {
          if (!sessions) return send(res, 404, { error: "sessions disabled" });
          try {
            const { n } = (await readJson(req)) as { n: number };
            return send(res, 200, sessions.answerPrompt(pa[1], Number(n)));
          } catch (e) {
            return sendHttpError(res, e);
          }
        }
        const pm = path.match(/^\/api\/sessions\/([^/]+)\/prompt-memo$/);
        if (pm && method === "POST") {
          if (!sessions) return send(res, 404, { error: "sessions disabled" });
          try {
            const { text } = (await readJson(req)) as { text: string };
            return send(res, 200, sessions.answerPromptMemo(pm[1], String(text ?? "")));
          } catch (e) {
            return sendHttpError(res, e);
          }
        }
        const pmulti = path.match(/^\/api\/sessions\/([^/]+)\/prompt-multi$/);
        if (pmulti && method === "POST") {
          if (!sessions) return send(res, 404, { error: "sessions disabled" });
          try {
            const { ns } = (await readJson(req)) as { ns: number[] };
            return send(res, 200, sessions.answerPromptMulti(pmulti[1], (Array.isArray(ns) ? ns : []).map(Number)));
          } catch (e) {
            return sendHttpError(res, e);
          }
        }
        const sm = path.match(/^\/api\/sessions\/([^/]+)\/(resume|close|open-terminal|background-terminal|terminate|remote-control|label)$/);
        if (sm && method === "POST") {
          if (!sessions) return send(res, 404, { error: "sessions disabled" });
          try {
            const id = sm[1];
            if (sm[2] === "resume") return send(res, 200, sessions.resume(id));
            if (sm[2] === "close") return send(res, 200, sessions.close(id));
            if (sm[2] === "terminate") return send(res, 200, sessions.terminate(id));
            if (sm[2] === "remote-control") {
              const { disconnect } = (await readJson(req)) as { disconnect?: boolean };
              return send(res, 200, sessions.connectRemote(id, !!disconnect));
            }
            if (sm[2] === "background-terminal") {
              sessions.backgroundTerminal(id);
              return send(res, 200, { ok: true });
            }
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
