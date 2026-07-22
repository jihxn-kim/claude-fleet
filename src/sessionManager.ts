import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync, fstatSync, readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import type { SessionStore } from "./sessionStore.js";
import type { SessionEntry, AvailableSession, AllSession, SessionPrompt, PromptOption } from "./types.js";

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
    this.spawnTmux(tmuxName, proj.path, this.claudeArgv("--session-id", id));
    const entry: SessionEntry = {
      id, project, projectPath: proj.path, tmuxName,
      status: "running", startedAt: this.now(), lastSeen: this.now(),
    };
    this.o.store.upsert(entry);
    return entry;
  }

  // Create a detached tmux session running claude. `-e COLORTERM=truecolor` so claude
  // renders 24-bit color themes (the launchd env lacks it), and mouse mode on so the
  // wheel scrolls the transcript when attached.
  private spawnTmux(tmuxName: string, cwd: string, argv: string[]): void {
    this.o.runner.run("tmux", ["new-session", "-d", "-s", tmuxName, "-c", cwd, "-e", "COLORTERM=truecolor", "claude", ...argv]);
    this.ensureServerOpts();
    try {
      this.o.runner.run("tmux", ["set-option", "-t", tmuxName, "mouse", "on"]);
    } catch {
      /* best-effort */
    }
  }

  // Make tmux transparent to claude's native terminal behavior:
  //  - extended-keys on + the extkeys feature → Shift+Enter reaches claude as a
  //    real newline instead of collapsing to a plain Enter (submit).
  //  - the RGB feature → 24-bit color themes render correctly.
  // Mouse/copy-mode bindings are left at tmux defaults on purpose: rebinding them to
  // stop accidental drag-select during scroll also kills intentional selection (tmux
  // can't tell the two drags apart). The right fix for that lives in iTerm2 (uncheck
  // "Report mouse clicks & drags"), not here.
  // Server-level, so this only needs to run once per tmux server.
  private serverOptsEnsured = false;
  private ensureServerOpts(): void {
    if (this.serverOptsEnsured) return;
    this.serverOptsEnsured = true;
    try {
      this.o.runner.run("tmux", ["set-option", "-s", "extended-keys", "on"]);
      let features = "";
      try {
        features = this.o.runner.run("tmux", ["show-options", "-s", "-v", "terminal-features"]);
      } catch {
        features = "";
      }
      for (const feat of ["RGB", "extkeys"]) {
        if (!features.includes(feat)) {
          this.o.runner.run("tmux", ["set-option", "-sa", "terminal-features", `xterm*:${feat}`]);
        }
      }
    } catch {
      /* best-effort */
    }
  }

  resume(id: string): SessionEntry {
    const s = this.o.store.getSession(id);
    if (!s) throw new HttpError(404, `no session ${id}`);
    if (s.status === "running") throw new HttpError(409, `session ${id} already running`);
    if (this.o.store.runningCount(s.project) >= 2) throw new HttpError(409, `max 2 running for ${s.project}`);
    this.killTmux(s.tmuxName); // clear a stale shell-dropped session → exactly one fresh
    this.spawnTmux(s.tmuxName, s.projectPath, this.claudeArgv("--resume", id, this.activeSessionIds().has(id)));
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
      // iTerm2 native tmux integration (-CC): tmux windows become real iTerm windows
      // with native scroll / selection / clipboard — no copy-mode cursor or snap-back.
      // (Enable Settings › General › tmux › "Automatically bury the tmux client session
      //  after connecting" to hide the control window.)
      let attached = false;
      try {
        attached = this.o.runner.run("tmux", ["list-clients", "-t", s.tmuxName, "-F", "#{client_tty}"]).trim().length > 0;
      } catch {
        attached = false;
      }
      if (attached) {
        // Already open via -CC — just bring iTerm forward. Re-attaching would spawn a
        // second control client and duplicate the native windows.
        this.o.runner.run("osascript", ["-e", `tell application "iTerm" to activate`]);
      } else {
        this.o.runner.run("osascript", [
          "-e", `tell application "iTerm"`,
          "-e", `activate`,
          "-e", `set nw to (create window with default profile)`,
          "-e", `tell current session of nw to write text "tmux -CC attach -t ${s.tmuxName}"`,
          "-e", `end tell`,
        ]);
      }
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

  // Send a running session back to the background: detach its terminal and close the
  // window. The tmux session (and claude) keep running headless.
  backgroundTerminal(id: string): void {
    const s = this.o.store.getSession(id);
    if (!s) throw new HttpError(404, `no session ${id}`);
    let tty = "";
    try {
      tty = this.o.runner.run("tmux", ["list-clients", "-t", s.tmuxName, "-F", "#{client_tty}"]).trim().split("\n")[0] ?? "";
    } catch {
      tty = "";
    }
    if (!tty) return; // nothing attached → already in background
    try {
      this.o.runner.run("tmux", ["detach-client", "-s", s.tmuxName]); // no running job → close won't prompt
    } catch {
      /* fine */
    }
    const term = this.getTerminal();
    try {
      if (term === "iterm") {
        this.o.runner.run("osascript", [
          "-e", `tell application "iTerm"`,
          "-e", `repeat with w in windows`,
          "-e", `repeat with tb in tabs of w`,
          "-e", `repeat with ss in sessions of tb`,
          "-e", `if tty of ss is "${tty}" then close w`,
          "-e", `end repeat`,
          "-e", `end repeat`,
          "-e", `end repeat`,
          "-e", `end tell`,
        ]);
      } else if (term === "terminal") {
        this.o.runner.run("osascript", [
          "-e", `tell application "Terminal"`,
          "-e", `repeat with w in windows`,
          "-e", `repeat with tb in tabs of w`,
          "-e", `if tty of tb is "${tty}" then close w`,
          "-e", `end repeat`,
          "-e", `end tell`,
        ]);
      }
    } catch {
      /* window already gone — session is detached either way */
    }
  }

  // Terminate a session: kill its tmux (stops claude) and drop it from the fleet.
  // The on-disk transcript stays, so it can be re-imported from 관리 later.
  terminate(id: string): { ok: boolean } {
    const s = this.o.store.getSession(id);
    if (!s) throw new HttpError(404, `no session ${id}`);
    try {
      this.o.runner.run("tmux", ["kill-session", "-t", s.tmuxName]);
    } catch {
      /* already gone */
    }
    this.o.store.removeSession(id);
    return { ok: true };
  }

  // Fire Claude's native /remote-control in the session so it can be driven from the
  // Claude mobile app / claude.ai/code (full typing, not just fleet's decision cards).
  // On an already-connected session, /remote-control opens a menu (Disconnect this
  // session / Show QR code / Continue); to disconnect we wait for it to render and
  // press Enter, which selects the first (default-highlighted) item — Disconnect.
  connectRemote(id: string, disconnect = false): { ok: boolean } {
    const s = this.o.store.getSession(id);
    if (!s) throw new HttpError(404, `no session ${id}`);
    // Slash commands only run at the idle prompt; while claude is generating, the
    // keystrokes just pile up in the input box unexecuted. Refuse with a clear message.
    let busy = false;
    try {
      busy = this.paneShowsBusy(this.o.runner.run("tmux", ["capture-pane", "-p", "-t", s.tmuxName]));
    } catch {
      /* can't read → assume idle */
    }
    if (busy) throw new HttpError(409, "세션이 작업 중이라 원격제어를 걸 수 없어요. ✅ 완료(유휴)일 때 눌러주세요.");
    const send = (...keys: string[]) => this.o.runner.run("tmux", ["send-keys", "-t", s.tmuxName, ...keys]);
    const nap = (sec: string) => {
      try {
        this.o.runner.run("sleep", [sec]);
      } catch {
        /* ignore */
      }
    };
    send("C-u"); // clear any residual/half-typed input first
    send("-l", "/remote-control");
    nap("0.4"); // let the input settle before submitting
    send("Enter"); // run the command
    if (disconnect) {
      // On a connected session /remote-control opens a menu: Disconnect this session /
      // Show QR code / Continue (default cursor on the last, "Continue"). Wait until it
      // actually renders — don't blind-navigate — then move the cursor precisely onto
      // "Disconnect this session" and select it.
      let pane = "";
      let opened = false;
      for (let i = 0; i < 6 && !opened; i++) {
        nap("0.4");
        try {
          pane = this.o.runner.run("tmux", ["capture-pane", "-p", "-t", s.tmuxName]);
        } catch {
          pane = "";
        }
        opened = /Disconnect this session/i.test(pane);
      }
      if (!opened) {
        throw new HttpError(409, "원격 해제 메뉴가 안 떠요 — 세션이 작업 중이거나 상태가 바뀐 듯. 잠시 후 다시 눌러줘.");
      }
      const items: { disc: boolean; cur: boolean }[] = [];
      for (const l of pane.split("\n")) {
        if (/Disconnect this session/i.test(l)) items.push({ disc: true, cur: /❯/.test(l) });
        else if (/Show QR code/i.test(l)) items.push({ disc: false, cur: /❯/.test(l) });
        else if (/^\s*❯?\s*Continue\b/i.test(l)) items.push({ disc: false, cur: /❯/.test(l) });
      }
      const target = items.findIndex((x) => x.disc);
      const cursor = items.findIndex((x) => x.cur);
      const delta = target >= 0 && cursor >= 0 ? target - cursor : -2; // fallback: 2 up from "Continue"
      const key = delta >= 0 ? "Down" : "Up";
      for (let i = 0; i < Math.abs(delta); i++) {
        send(key);
        nap("0.15");
      }
      send("Enter");
    }
    return { ok: true };
  }

  reconcile(): void {
    const live = new Set(this.liveFleetSessions());
    for (const s of this.o.store.listSessions()) {
      if (s.status !== "running") continue;
      // tmux gone, OR tmux alive but claude exited to a shell → mark stopped so the panel
      // shows it as ⚫ inactive with a reactivate button (instead of a dead "running").
      if (!live.has(s.tmuxName) || this.paneIsShell(s.tmuxName)) {
        this.o.store.setStatus(s.id, "stopped");
      }
    }
  }

  // A tmux session can outlive its claude — e.g. an adopted session (user-created tmux
  // running claude) whose claude exits drops back to a shell while the tmux lives on.
  // Detect that via the pane's foreground command so reconcile doesn't report a dead
  // shell as "running". (Running a Bash tool keeps claude as the foreground command, so
  // this doesn't false-positive mid-work.)
  private paneIsShell(tmuxName: string): boolean {
    try {
      const cmd = this.o.runner.run("tmux", ["display-message", "-p", "-t", tmuxName, "#{pane_current_command}"]).trim();
      return /^-?(zsh|bash|fish|sh|dash|tcsh|ksh|csh)$/i.test(cmd);
    } catch {
      return false;
    }
  }

  // Best-effort kill: clears a stale tmux session before we spawn a fresh one, so
  // reactivating a shell-dropped session reuses the one name instead of hitting a
  // "duplicate session" error. A no-op (ignored error) if nothing is there.
  private killTmux(tmuxName: string): void {
    try {
      this.o.runner.run("tmux", ["kill-session", "-t", tmuxName]);
    } catch {
      /* not running — fine */
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
    this.killTmux(tmuxName); // clear a stale session with this name → exactly one fresh
    this.spawnTmux(tmuxName, proj.path, this.claudeArgv("--resume", id, this.activeSessionIds().has(id)));
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

  // `claude agents --json` — active sessions with their live state. Cached a
  // few seconds so the panel's 2s poll doesn't spawn the CLI every time.
  private agentsCache: { at: number; list: Array<{ sessionId?: string; id?: string; status?: string; state?: string }> } | null = null;
  private agents(): Array<{ sessionId?: string; id?: string; status?: string; state?: string }> {
    const now = Date.now();
    if (this.agentsCache && now - this.agentsCache.at < 3000) return this.agentsCache.list;
    try {
      const list = JSON.parse(this.o.runner.run("claude", ["agents", "--json"]));
      this.agentsCache = { at: now, list };
      return list;
    } catch {
      return this.agentsCache?.list ?? [];
    }
  }

  // Ids of currently-running sessions (so we only --fork-session when we must).
  private activeSessionIds(): Set<string> {
    return new Set(this.agents().map((a) => a.sessionId ?? a.id ?? "").filter(Boolean));
  }

  private activityMap: Record<string, string> = {}; // id → "busy" | "idle"
  private terminalMap: Record<string, boolean> = {}; // id → a terminal window is attached
  private remoteMap: Record<string, boolean> = {}; // id → remote-control connected
  private promptMap: Record<string, SessionPrompt | null> = {}; // id → on-screen menu, if any

  // Detect a native on-screen selection menu — permission prompt, AskUserQuestion, plan
  // approval, yes/no, the /remote-control menu — none of which are MCP request_decision
  // calls, so they'd otherwise be invisible to the panel. The shared shape is numbered
  // options above a footer like "Enter to select" / "Esc to cancel". Returns the options
  // plus which one the cursor (❯) is on, so answers can navigate there.
  private parsePrompt(pane: string): (SessionPrompt & { selectedIdx: number; multiSelect: boolean }) | null {
    const tail = pane.split("\n").slice(-30);
    // The footer is the menu's LAST line ("Enter to select", "Esc to cancel", "Tab to
    // amend", …). Scan from the bottom — the question above ("Do you want to proceed?")
    // must NOT be mistaken for the footer, or the options below it get skipped.
    let footerIdx = -1;
    for (let i = tail.length - 1; i >= 0; i--) {
      if (/(Enter to select|↑\/↓ to navigate|Esc to cancel|Tab to amend|ctrl\+e to explain)/i.test(tail[i])) {
        footerIdx = i;
        break;
      }
    }
    if (footerIdx < 0) return null;
    const options: PromptOption[] = [];
    let selectedIdx = -1;
    let firstOptLine = -1;
    let multiSelect = false;
    for (let i = 0; i < footerIdx; i++) {
      const m = tail[i].match(/^\s*(❯?)\s*(\d+)\.\s+(.*\S)\s*$/);
      if (!m) continue;
      if (firstOptLine < 0) firstOptLine = i;
      if (m[1].includes("❯")) selectedIdx = options.length;
      let label = m[3].trim();
      const cb = /^\[.\]\s*/.exec(label); // multi-select options render as "[ ] Label"
      if (cb) {
        multiSelect = true;
        label = label.slice(cb[0].length).trim();
      }
      options.push({ n: Number(m[2]), label });
    }
    if (options.length < 2) return null;
    // context = the block above the options, verbatim (the command box for a permission
    // prompt, the question for AskUserQuestion, …). Its top is the box rule (a long ───
    // line) if there's one within ~24 lines; otherwise just the few lines of question.
    let topIdx = -1;
    const floor = Math.max(0, firstOptLine - 24);
    for (let i = firstOptLine - 1; i >= floor; i--) {
      if (/^[\s─—]{20,}$/.test(tail[i])) {
        topIdx = i + 1;
        break;
      }
    }
    if (topIdx < 0) topIdx = Math.max(0, firstOptLine - 6);
    const context = tail
      .slice(topIdx, firstOptLine)
      .map((l) => l.replace(/[│]/g, "").replace(/\s+$/, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { context, options, multiSelect, selectedIdx: selectedIdx < 0 ? 0 : selectedIdx };
  }

  // A session is "busy" only while claude is actively generating or running a tool —
  // exactly when its status line shows "esc to interrupt". That line is stable through a
  // turn (no flicker) and, crucially, is NOT shown while you're merely typing at the
  // idle prompt. Only the bottom lines are checked so conversation text that happens to
  // mention "interrupt" can't cause a false positive. Works for detached sessions and
  // survives --fork-session id changes (it reads the screen, not a session file).
  private paneShowsBusy(pane: string): boolean {
    const lines = pane.split("\n");
    // main is generating / running a tool
    if (/esc to interrupt/i.test(lines.slice(-8).join("\n"))) return true;
    // blocked waiting on a background subagent (Task) — still working, just no
    // "esc to interrupt" line. The agent manager list can push this up a few rows.
    if (/Waiting for \d+ background agents? to finish/i.test(lines.slice(-16).join("\n"))) return true;
    return false;
  }

  // While remote-control is connected, claude shows a persistent "/rc" affordance in the
  // bottom-right status area — unlike the "is active" line, it doesn't scroll away, so a
  // single bottom-of-pane check is enough. Reflects panel AND manual terminal connects.
  private paneShowsRemote(pane: string): boolean {
    return /\/rc\b/.test(pane.split("\n").slice(-4).join("\n"));
  }

  // Sample every running session once. Called on a fixed interval by the server, so
  // detection cadence is independent of how many panels are polling. In one pass it
  // derives busy/idle, whether a terminal window is attached (tmux clients), and whether
  // Claude's native remote-control is connected.
  sampleActivity(): void {
    const next: Record<string, string> = {};
    const term: Record<string, boolean> = {};
    const remote: Record<string, boolean> = {};
    const prompt: Record<string, SessionPrompt | null> = {};
    for (const s of this.o.store.listSessions()) {
      if (s.status !== "running") continue;
      let pane: string | null = null;
      try {
        pane = this.o.runner.run("tmux", ["capture-pane", "-p", "-t", s.tmuxName]);
      } catch {
        /* tmux session gone */
      }
      if (pane === null) {
        next[s.id] = "idle";
        term[s.id] = false;
        remote[s.id] = false;
        prompt[s.id] = null;
        continue;
      }
      next[s.id] = this.paneShowsBusy(pane) ? "busy" : "idle";
      remote[s.id] = this.paneShowsRemote(pane);
      const p = this.parsePrompt(pane);
      prompt[s.id] = p ? { context: p.context, options: p.options, multiSelect: p.multiSelect } : null;
      let clients = "";
      try {
        clients = this.o.runner.run("tmux", ["list-clients", "-t", s.tmuxName]).trim();
      } catch {
        clients = "";
      }
      term[s.id] = clients.length > 0;
    }
    this.activityMap = next;
    this.terminalMap = term;
    this.remoteMap = remote;
    this.promptMap = prompt;
  }

  // Read the most recent sample (cheap; no shelling out here).
  sessionActivity(): Record<string, string> {
    return this.activityMap;
  }
  terminalOpen(id: string): boolean {
    return this.terminalMap[id] ?? false;
  }
  remoteActive(id: string): boolean {
    return this.remoteMap[id] ?? false;
  }
  sessionPrompt(id: string): SessionPrompt | null {
    return this.promptMap[id] ?? null;
  }

  // Answer a multi-select AskUserQuestion from the panel: toggle each chosen option with
  // Enter (cursor stays put after a toggle), then Right → the Submit tab, then Enter to
  // confirm. Mirrors the exact CLI flow: ↑/↓ navigate, Enter toggles [ ]→[✔], → submits.
  answerPromptMulti(id: string, ns: number[]): { ok: boolean } {
    const s = this.o.store.getSession(id);
    if (!s) throw new HttpError(404, `no session ${id}`);
    let pane = "";
    try {
      pane = this.o.runner.run("tmux", ["capture-pane", "-p", "-t", s.tmuxName]);
    } catch {
      /* fall through */
    }
    const p = this.parsePrompt(pane);
    if (!p || !p.multiSelect) throw new HttpError(409, "지금 이 세션에 다중선택 질문이 없어요.");
    const targets = ns.map((n) => p.options.findIndex((o) => o.n === n)).filter((i) => i >= 0);
    if (!targets.length) throw new HttpError(400, "고른 옵션이 없어요.");
    const send = (...keys: string[]) => this.o.runner.run("tmux", ["send-keys", "-t", s.tmuxName, ...keys]);
    const nap = (sec: string) => {
      try {
        this.o.runner.run("sleep", [sec]);
      } catch {
        /* ignore */
      }
    };
    let cursor = p.selectedIdx;
    for (const idx of targets) {
      const delta = idx - cursor;
      const key = delta >= 0 ? "Down" : "Up";
      for (let i = 0; i < Math.abs(delta); i++) {
        send(key);
        nap("0.12");
      }
      send("Enter"); // toggle [ ]→[✔]; cursor stays on this option
      nap("0.15");
      cursor = idx;
    }
    send("Right"); // → to the Submit tab (Review your answers)
    nap("0.4");
    send("Enter"); // confirm: "1. Submit answers"
    return { ok: true };
  }

  // Answer an on-screen AskUserQuestion with free text: navigate to its "Type something"
  // option, open the input, type the memo, submit. Lets the panel do memo answers that
  // otherwise only work at the CLI.
  answerPromptMemo(id: string, text: string): { ok: boolean } {
    const s = this.o.store.getSession(id);
    if (!s) throw new HttpError(404, `no session ${id}`);
    let pane = "";
    try {
      pane = this.o.runner.run("tmux", ["capture-pane", "-p", "-t", s.tmuxName]);
    } catch {
      /* fall through */
    }
    const p = this.parsePrompt(pane);
    if (!p) throw new HttpError(409, "지금 이 세션에 선택 프롬프트가 없어요.");
    const idx = p.options.findIndex((o) => /type something/i.test(o.label));
    if (idx < 0) throw new HttpError(409, "이 질문엔 자유입력(Type something) 옵션이 없어요.");
    const clean = text.replace(/\r?\n/g, " ").trim();
    if (!clean) throw new HttpError(400, "메모가 비어 있어요.");
    const send = (...keys: string[]) => this.o.runner.run("tmux", ["send-keys", "-t", s.tmuxName, ...keys]);
    const nap = (sec: string) => {
      try {
        this.o.runner.run("sleep", [sec]);
      } catch {
        /* ignore */
      }
    };
    const delta = idx - p.selectedIdx;
    const key = delta >= 0 ? "Down" : "Up";
    for (let i = 0; i < Math.abs(delta); i++) {
      send(key);
      nap("0.12");
    }
    // Cursor is now ON "Type something" — do NOT press Enter (that declines). Just type:
    // the text replaces the label inline and puts the option into edit mode; Enter submits.
    nap("0.2");
    send("-l", clean);
    nap("0.2");
    send("Enter");
    return { ok: true };
  }

  // Answer an on-screen menu from the panel: re-read the pane, then navigate the cursor
  // from where it currently sits to the chosen option and press Enter. Navigating (vs
  // typing a number) works whether or not the menu accepts number shortcuts.
  answerPrompt(id: string, n: number): { ok: boolean } {
    const s = this.o.store.getSession(id);
    if (!s) throw new HttpError(404, `no session ${id}`);
    let pane = "";
    try {
      pane = this.o.runner.run("tmux", ["capture-pane", "-p", "-t", s.tmuxName]);
    } catch {
      /* fall through to the no-prompt error */
    }
    const p = this.parsePrompt(pane);
    if (!p) throw new HttpError(409, "지금 이 세션에 선택 프롬프트가 없어요.");
    const targetIdx = p.options.findIndex((o) => o.n === n);
    if (targetIdx < 0) throw new HttpError(409, `옵션 ${n}을(를) 찾을 수 없어요.`);
    const delta = targetIdx - p.selectedIdx;
    const key = delta >= 0 ? "Down" : "Up";
    for (let i = 0; i < Math.abs(delta); i++) {
      this.o.runner.run("tmux", ["send-keys", "-t", s.tmuxName, key]);
      try {
        this.o.runner.run("sleep", ["0.12"]);
      } catch {
        /* ignore */
      }
    }
    this.o.runner.run("tmux", ["send-keys", "-t", s.tmuxName, "Enter"]);
    return { ok: true };
  }

  private claudeArgv(resumeFlag: string, id: string, fork = false): string[] {
    // Resuming a session that's live as a background agent fails ("currently
    // running as a background agent"); --fork-session branches a copy only
    // then. A non-running session resumes in place (same id, no duplicate).
    const head = resumeFlag === "--resume" && fork ? [resumeFlag, id, "--fork-session"] : [resumeFlag, id];
    // No --mcp-config/--strict-mcp-config: decisions now use native AskUserQuestion
    // (see fleet-rule.txt), so the session keeps the user's own MCP servers and normal
    // permission setup — it behaves like a plain claude, plus the fleet rule.
    return [
      ...head,
      "--permission-mode", this.getPermissionMode(),
      "--append-system-prompt", this.o.ruleText,
    ];
  }
}
