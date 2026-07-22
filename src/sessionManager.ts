import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync, fstatSync, readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import type { SessionStore } from "./sessionStore.js";
import type { SessionEntry, AvailableSession, AllSession } from "./types.js";

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
  configPath?: string; // where the chosen terminal app is persisted
  now?: () => string;
  genId?: () => string;
}

// Known macOS terminal apps and how to detect them. openTerminal picks the
// user's chosen one (or the first installed) so this works on any machine.
const TERMINALS = [
  { id: "iterm", name: "iTerm2", app: "/Applications/iTerm.app" },
  { id: "terminal", name: "Terminal", app: "/System/Applications/Utilities/Terminal.app" },
  { id: "warp", name: "Warp", app: "/Applications/Warp.app" },
  { id: "ghostty", name: "Ghostty", app: "/Applications/Ghostty.app" },
  { id: "wezterm", name: "WezTerm", app: "/Applications/WezTerm.app" },
  { id: "alacritty", name: "Alacritty", app: "/Applications/Alacritty.app" },
  { id: "kitty", name: "kitty", app: "/Applications/kitty.app" },
  { id: "hyper", name: "Hyper", app: "/Applications/Hyper.app" },
];

interface FleetConfig {
  terminal?: string;
  permissionMode?: string;
}
function readConfig(path: string | undefined): FleetConfig {
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FleetConfig;
  } catch {
    return {};
  }
}
function writeConfig(path: string, cfg: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2));
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function encodeProjectDir(path: string): string {
  return path.replace(/[/.]/g, "-");
}

// Read a bounded chunk from the start or end of a file — never the whole
// thing (session files can be hundreds of MB). Agentic sessions bury the
// last user message under MBs of tool turns, so the tail window is wide.
const PREVIEW_HEAD = 65536; // 64KB
const PREVIEW_TAIL = 2_097_152; // 2MB
function readChunk(file: string, fromEnd: boolean, maxBytes: number): string {
  try {
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(maxBytes, size);
      const pos = fromEnd ? size - len : 0;
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, pos);
      return buf.toString("utf8", 0, n);
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

// Extract a real user prompt from a jsonl line, or "" if it's not one
// (assistant turn, tool_result, or an auto-generated caveat/system turn).
function extractUserText(line: string): string {
  if (!line.trim()) return "";
  let e: unknown;
  try {
    e = JSON.parse(line);
  } catch {
    return ""; // truncated / non-json
  }
  const obj = e as { type?: string; message?: { content?: unknown } };
  if (obj.type !== "user" || !obj.message) return "";
  const c = obj.message.content;
  let raw = "";
  if (typeof c === "string") raw = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => (b as { type?: string })?.type === "tool_result")) return "";
    raw = c
      .filter((b) => (b as { type?: string })?.type === "text")
      .map((b) => (b as { text?: string }).text ?? "")
      .join("\n");
  }
  // drop pasted shell-prompt lines (e.g. "user@host ~ % cmd") so the user's
  // actual words surface instead of terminal output they pasted in.
  const prose = raw
    .split("\n")
    .filter((l) => !/^\s*[\w.+-]+@[\w.+-]+.*[%$#]\s/.test(l))
    .join(" ");
  const text = prose.replace(/[\x00-\x1f]/g, " ").trim().replace(/\s+/g, " ");
  if (!text) return "";
  // skip auto-generated / system turns — not the user's own prompt
  if (/^(<local-command|<command-|Caveat|<task-notification|\[SYSTEM|This session is being continued)/.test(text)) return "";
  return text;
}

// Preview of what a session is about, for identifying it in the adopt list.
// Prefers the LAST real user message (recent context = best identifier),
// falling back to the first. Both reads are bounded to 64KB.
function sessionPreview(file: string): string {
  const trunc = (t: string): string => (t.length > 90 ? t.slice(0, 90) + "…" : t);
  const tail = readChunk(file, true, PREVIEW_TAIL).split("\n");
  for (let i = tail.length - 1; i >= 0; i--) {
    const t = extractUserText(tail[i]);
    if (t) return trunc(t);
  }
  for (const line of readChunk(file, false, PREVIEW_HEAD).split("\n")) {
    const t = extractUserText(line);
    if (t) return trunc(t);
  }
  return "";
}

// A real conversation has assistant turns; a stub (claude opened but never
// used) has none. Check head AND tail — a resumed session's head can be one
// giant continuation-summary with the first assistant turn far below it.
function hasConversation(file: string): boolean {
  return (
    readChunk(file, false, PREVIEW_HEAD).includes('"type":"assistant"') ||
    readChunk(file, true, PREVIEW_TAIL).includes('"type":"assistant"')
  );
}

// The real working directory a session ran in, from the session file itself
// (folder-name encoding is lossy, but records carry an exact "cwd").
function findCwdInChunk(chunk: string): string | null {
  for (const line of chunk.split("\n")) {
    if (!line.includes('"cwd"')) continue;
    try {
      const e = JSON.parse(line) as { cwd?: unknown };
      if (typeof e.cwd === "string" && e.cwd) return e.cwd;
    } catch {
      /* skip non-json / truncated line */
    }
  }
  return null;
}
function sessionCwd(file: string): string | null {
  // Head first; if a resumed session's giant continuation-summary pushed the
  // first cwd record past the head window, recent (tail) records carry it too.
  return findCwdInChunk(readChunk(file, false, PREVIEW_HEAD)) ?? findCwdInChunk(readChunk(file, true, PREVIEW_TAIL));
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
    this.spawnTmux(tmuxName, proj.path, this.claudeArgv("--session-id", id, mcpPath));
    const entry: SessionEntry = {
      id, project, projectPath: proj.path, tmuxName,
      status: "running", startedAt: this.now(), lastSeen: this.now(),
    };
    this.o.store.upsert(entry);
    return entry;
  }

  // Create a detached tmux session running claude. `-e COLORTERM=truecolor`
  // so claude renders themes in real 24-bit color (the launchd env lacks it),
  // and mouse mode on so the transcript can be scrolled when attached.
  private spawnTmux(tmuxName: string, cwd: string, argv: string[]): void {
    this.o.runner.run("tmux", ["new-session", "-d", "-s", tmuxName, "-c", cwd, "-e", "COLORTERM=truecolor", "claude", ...argv]);
    try {
      this.o.runner.run("tmux", ["set-option", "-t", tmuxName, "mouse", "on"]);
    } catch {
      /* best-effort */
    }
  }

  resume(id: string): SessionEntry {
    const s = this.o.store.getSession(id);
    if (!s) throw new HttpError(404, `no session ${id}`);
    if (s.status === "running") throw new HttpError(409, `session ${id} already running`);
    if (this.o.store.runningCount(s.project) >= 2) throw new HttpError(409, `max 2 running for ${s.project}`);
    const mcpPath = this.writeMcpConfig(id);
    this.spawnTmux(s.tmuxName, s.projectPath, this.claudeArgv("--resume", id, mcpPath, this.activeSessionIds().has(id)));
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

  // Terminal apps installed on this machine.
  detectTerminals(): Array<{ id: string; name: string }> {
    return TERMINALS.filter((t) => existsSync(t.app)).map((t) => ({ id: t.id, name: t.name }));
  }

  // The chosen terminal (persisted), else the first installed (iTerm preferred
  // by TERMINALS order), else "terminal".
  getTerminal(): string {
    const detected = this.detectTerminals();
    const chosen = readConfig(this.o.configPath).terminal;
    if (chosen && detected.some((t) => t.id === chosen)) return chosen;
    return detected[0]?.id ?? "terminal";
  }

  setTerminal(id: string): void {
    if (this.o.configPath) writeConfig(this.o.configPath, { ...readConfig(this.o.configPath), terminal: id });
  }

  // Permission mode new sessions launch with. Default acceptEdits (edits auto,
  // risky tools still ask). bypassPermissions = fully autonomous.
  getPermissionMode(): string {
    return readConfig(this.o.configPath).permissionMode ?? "auto";
  }

  setPermissionMode(mode: string): void {
    if (this.o.configPath) writeConfig(this.o.configPath, { ...readConfig(this.o.configPath), permissionMode: mode });
  }

  openTerminal(id: string): void {
    const s = this.o.store.getSession(id);
    if (!s) throw new HttpError(404, `no session ${id}`);
    const attach = `tmux attach -t ${s.tmuxName}`; // tmuxName is slug-safe, no injection
    const term = this.getTerminal();
    if (term === "iterm") {
      this.o.runner.run("osascript", [
        "-e", `tell application "iTerm" to create window with default profile`,
        "-e", `tell application "iTerm" to tell current session of current window to write text "${attach}"`,
      ]);
    } else if (term === "terminal") {
      this.o.runner.run("osascript", ["-e", `tell application "Terminal" to do script "${attach}"`]);
    } else {
      // generic: a .command script opened with the chosen app
      const app = TERMINALS.find((t) => t.id === term)?.app;
      const scriptPath = join(this.o.mcpDir, `attach-${s.id.slice(0, 6)}.command`);
      mkdirSync(dirname(scriptPath), { recursive: true });
      writeFileSync(scriptPath, `#!/bin/bash\n${attach}\n`, { mode: 0o755 });
      this.o.runner.run("open", app ? ["-a", app, scriptPath] : [scriptPath]);
    }
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
    const managed = new Set(this.o.store.listSessions().map((x) => x.id));
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .filter((f) => !managed.has(f.replace(/\.jsonl$/, ""))) // hide sessions fleet already manages
      .filter((f) => hasConversation(join(dir, f))); // skip empty stub sessions
    const out: AvailableSession[] = files.map((f) => {
      const full = join(dir, f);
      return {
        id: f.replace(/\.jsonl$/, ""),
        mtime: statSync(full).mtime.toISOString(),
        snippet: sessionPreview(full),
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
    this.spawnTmux(tmuxName, proj.path, this.claudeArgv("--resume", id, mcpPath, this.activeSessionIds().has(id)));
    const entry: SessionEntry = {
      id, project, projectPath: proj.path, tmuxName,
      status: "running", startedAt: this.now(), lastSeen: this.now(),
    };
    this.o.store.upsert(entry);
    return entry;
  }

  // Scan ALL of ~/.claude/projects (no registration needed) for the most
  // recent real sessions across every project, newest first.
  scanRecent(limit = 50): AllSession[] {
    const root = this.o.claudeProjectsDir;
    if (!existsSync(root)) return [];
    const running = this.runningCwds();
    const all: Array<{ full: string; id: string; mtimeMs: number }> = [];
    for (const folder of readdirSync(root)) {
      let files: string[];
      try {
        files = readdirSync(join(root, folder));
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const full = join(root, folder, f);
        try {
          all.push({ full, id: f.replace(/\.jsonl$/, ""), mtimeMs: statSync(full).mtimeMs });
        } catch {
          /* skip */
        }
      }
    }
    all.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const managed = new Set(this.o.store.listSessions().map((x) => x.id));
    const out: AllSession[] = [];
    for (const s of all) {
      if (out.length >= limit) break;
      if (managed.has(s.id)) continue; // hide sessions fleet already manages
      const cwd = sessionCwd(s.full);
      if (!cwd || !existsSync(cwd)) continue;
      if (!hasConversation(s.full)) continue; // skip stubs
      out.push({
        id: s.id,
        projectPath: cwd,
        projectName: basename(cwd) || cwd,
        mtime: new Date(s.mtimeMs).toISOString(),
        snippet: sessionPreview(s.full),
        running: running.has(cwd),
      });
    }
    return out;
  }

  // Set a user-friendly name for a session (shown in the panel).
  setLabel(id: string, label: string): SessionEntry {
    const s = this.o.store.getSession(id);
    if (!s) throw new HttpError(404, `no session ${id}`);
    s.label = label;
    this.o.store.upsert(s);
    return s;
  }

  // Adopt a session found by scanRecent — auto-registers its project by path.
  adoptByPath(id: string, path: string): SessionEntry {
    const existing = this.o.store.listProjects().find((p) => p.path === path);
    const name = existing?.name ?? (basename(path) || path);
    if (!existing) this.o.store.addProject(name, path);
    return this.adopt(id, name);
  }

  // Best-effort: cwds of live `claude` processes (for a "running" badge).
  private runningCwds(): Set<string> {
    try {
      const out = this.o.runner.run("/bin/bash", [
        "-c",
        'for pid in $(/usr/bin/pgrep -x claude 2>/dev/null); do /usr/sbin/lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | /usr/bin/sed -n "s/^n//p"; done',
      ]);
      return new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
    } catch {
      return new Set();
    }
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

  // Active (running) claude session ids, so we only --fork-session when we
  // must — resuming a NON-running session in place avoids a duplicate copy.
  private activeSessionIds(): Set<string> {
    try {
      const arr = JSON.parse(this.o.runner.run("claude", ["agents", "--json"])) as Array<{ sessionId?: string; id?: string }>;
      return new Set(arr.map((a) => a.sessionId ?? a.id ?? "").filter(Boolean));
    } catch {
      return new Set();
    }
  }

  private claudeArgv(resumeFlag: string, id: string, mcpPath: string, fork = false): string[] {
    // Resuming a session that's live as a background agent fails ("currently
    // running as a background agent"); --fork-session branches a copy only
    // then. A non-running session resumes in place (same id, no duplicate).
    const head = resumeFlag === "--resume" && fork ? [resumeFlag, id, "--fork-session"] : [resumeFlag, id];
    return [
      ...head,
      "--permission-mode", this.getPermissionMode(),
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
