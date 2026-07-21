import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { SessionStore } from "./sessionStore.js";
import type { SessionEntry, AvailableSession } from "./types.js";

export interface CommandRunner {
  run(cmd: string, args: string[]): string;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export interface SessionManagerOpts {
  store: SessionStore;
  runner: CommandRunner;
  repoRoot: string;
  orchUrl: string;
  mcpDir: string;
  ruleText: string;
  claudeProjectsDir: string;
  now?: () => string;
  genId?: () => string;
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function encodeProjectDir(path: string): string {
  return path.replace(/[/.]/g, "-");
}

function firstUserSnippet(file: string): string {
  try {
    const lines = readFileSync(file, "utf8").split("\n").slice(0, 200);
    for (const line of lines) {
      if (!line.trim()) continue;
      let e: unknown;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const obj = e as { type?: string; message?: { content?: unknown } };
      if (obj.type !== "user" || !obj.message) continue;
      const c = obj.message.content;
      let text = "";
      if (typeof c === "string") text = c;
      else if (Array.isArray(c))
        text = c
          .filter((b) => (b as { type?: string })?.type === "text")
          .map((b) => (b as { text?: string }).text ?? "")
          .join(" ");
      text = text.trim().replace(/\s+/g, " ");
      if (text) return text.length > 80 ? text.slice(0, 80) + "…" : text;
    }
  } catch {
    /* ignore unreadable file */
  }
  return "";
}

export class SessionManager {
  private now: () => string;
  private genId: () => string;
  constructor(private o: SessionManagerOpts) {
    this.now = o.now ?? (() => new Date().toISOString());
    this.genId = o.genId ?? (() => randomUUID());
  }

  get store(): SessionStore {
    return this.o.store;
  }

  launch(project: string): SessionEntry {
    const proj = this.o.store.getProject(project);
    if (!proj) throw new HttpError(400, `unknown project: ${project}`);
    if (this.o.store.runningCount(project) >= 2) throw new HttpError(409, `max 2 running for ${project}`);
    const id = this.genId();
    const tmuxName = `fleet__${slug(project)}__${id.slice(0, 6)}`;
    const mcpPath = this.writeMcpConfig(id);
    this.o.runner.run("tmux", [
      "new-session", "-d", "-s", tmuxName, "-c", proj.path,
      "claude", ...this.claudeArgv("--session-id", id, mcpPath),
    ]);
    const entry: SessionEntry = {
      id, project, projectPath: proj.path, tmuxName,
      status: "running", startedAt: this.now(), lastSeen: this.now(),
    };
    this.o.store.upsert(entry);
    return entry;
  }

  resume(id: string): SessionEntry {
    const s = this.o.store.getSession(id);
    if (!s) throw new HttpError(404, `no session ${id}`);
    if (s.status === "running") throw new HttpError(409, `session ${id} already running`);
    if (this.o.store.runningCount(s.project) >= 2) throw new HttpError(409, `max 2 running for ${s.project}`);
    const mcpPath = this.writeMcpConfig(id);
    this.o.runner.run("tmux", [
      "new-session", "-d", "-s", s.tmuxName, "-c", s.projectPath,
      "claude", ...this.claudeArgv("--resume", id, mcpPath),
    ]);
    s.status = "running";
    s.startedAt = this.now();
    s.lastSeen = this.now();
    this.o.store.upsert(s);
    return s;
  }

  close(id: string): SessionEntry {
    const s = this.o.store.getSession(id);
    if (!s) throw new HttpError(404, `no session ${id}`);
    try {
      this.o.runner.run("tmux", ["kill-session", "-t", s.tmuxName]);
    } catch {
      // already gone — fine
    }
    return this.o.store.setStatus(id, "stopped")!;
  }

  openTerminal(id: string): void {
    const s = this.o.store.getSession(id);
    if (!s) throw new HttpError(404, `no session ${id}`);
    this.o.runner.run("osascript", [
      "-e", `tell application "Terminal" to do script "tmux attach -t ${s.tmuxName}"`,
    ]);
  }

  reconcile(): void {
    const live = new Set(this.liveFleetSessions());
    for (const s of this.o.store.listSessions()) {
      if (s.status === "running" && !live.has(s.tmuxName)) {
        this.o.store.setStatus(s.id, "stopped");
      }
    }
  }

  discover(project: string): AvailableSession[] {
    const proj = this.o.store.getProject(project);
    if (!proj) throw new HttpError(400, `unknown project: ${project}`);
    const dir = join(this.o.claudeProjectsDir, encodeProjectDir(proj.path));
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    const out: AvailableSession[] = files.map((f) => {
      const full = join(dir, f);
      return {
        id: f.replace(/\.jsonl$/, ""),
        mtime: statSync(full).mtime.toISOString(),
        snippet: firstUserSnippet(full),
      };
    });
    out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    return out;
  }

  adopt(id: string, project: string): SessionEntry {
    const proj = this.o.store.getProject(project);
    if (!proj) throw new HttpError(400, `unknown project: ${project}`);
    const existing = this.o.store.getSession(id);
    if (existing?.status === "running") throw new HttpError(409, `session ${id} already running`);
    if (this.o.store.runningCount(project) >= 2) throw new HttpError(409, `max 2 running for ${project}`);
    const file = join(this.o.claudeProjectsDir, encodeProjectDir(proj.path), `${id}.jsonl`);
    if (!existsSync(file)) throw new HttpError(404, `no session ${id} in project ${project}`);
    const tmuxName = `fleet__${slug(project)}__${id.slice(0, 6)}`;
    const mcpPath = this.writeMcpConfig(id);
    this.o.runner.run("tmux", [
      "new-session", "-d", "-s", tmuxName, "-c", proj.path,
      "claude", ...this.claudeArgv("--resume", id, mcpPath),
    ]);
    const entry: SessionEntry = {
      id, project, projectPath: proj.path, tmuxName,
      status: "running", startedAt: this.now(), lastSeen: this.now(),
    };
    this.o.store.upsert(entry);
    return entry;
  }

  private liveFleetSessions(): string[] {
    let out = "";
    try {
      out = this.o.runner.run("tmux", ["list-sessions", "-F", "#{session_name}"]);
    } catch {
      return []; // no tmux server = no live sessions
    }
    return out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("fleet__"));
  }

  private claudeArgv(resumeFlag: string, id: string, mcpPath: string): string[] {
    return [
      resumeFlag, id,
      "--permission-mode", "acceptEdits",
      "--append-system-prompt", this.o.ruleText,
      "--mcp-config", mcpPath,
      "--strict-mcp-config",
      "--allowedTools", "mcp__fleet__request_decision",
    ];
  }

  private writeMcpConfig(id: string): string {
    const path = join(this.o.mcpDir, `${id}.json`);
    const cfg = {
      mcpServers: {
        fleet: {
          command: join(this.o.repoRoot, "node_modules/.bin/tsx"),
          args: [join(this.o.repoRoot, "src/mcpBridge.ts")],
          env: { FLEET_URL: this.o.orchUrl, FLEET_SESSION_TOKEN: id },
        },
      },
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cfg, null, 2));
    return path;
  }
}
