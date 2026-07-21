# Claude 함대 컨트롤 — Phase 2 (세션 생명주기) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 오케스트레이터가 프로젝트별 세션을 tmux로 띄우고/이어가고(resume)/닫고, running 최대 2를 강제하며, 패널·CLI에서 관리하고 tmux 생사를 동기화한다.

**Architecture:** Phase 1의 단일 오케스트레이터 프로세스(맥에서 상시)에 세션 관리 계층을 얹는다. `SessionStore`(projects.json/sessions.json 영속) 위에 `SessionManager`(주입된 command runner로 tmux/osascript 실행 + uuid + per-session mcp config)가 launch/resume/close/openTerminal/reconcile를 수행. HTTP에 세션 엔드포인트를 추가하고, CLI(`fleet`)와 패널 세션 뷰가 그걸 호출. 세션 id = claude `--session-id` uuid = fleet 토큰 = tmux 이름 접미로 통일.

**Tech Stack:** 기존 Node 24 + TypeScript(ESM/NodeNext) + tsx + vitest. 신규 런타임 의존성 없음(uuid는 `node:crypto`, tmux/osascript는 `node:child_process`).

## Global Constraints

- package.json `"type": "module"`; 상대 import는 `.js` 확장자(NodeNext ESM). 빌드 없음(tsx/vitest).
- 포트 4179, 패널 API는 `?token=`/`x-fleet-token` 가드(Phase 1과 동일). 세션용 `/internal/*`는 토큰 없음.
- **세션 id = `crypto.randomUUID()`**. 이 uuid 하나가 claude 세션id(`--session-id`) = fleet 세션토큰(`FLEET_SESSION_TOKEN`) = tmux 이름 접미로 **통일**된다.
- tmux 세션 이름: `fleet__<projectSlug>__<uuid앞6자>` (`slug` = 영숫자 외 `-`).
- 프로젝트당 **running 최대 2** 강제(초과 launch는 409, 아무 것도 안 만듦).
- 세션 실행 flag(검증됨): `--permission-mode acceptEdits`, `--append-system-prompt <fleet-rule.txt 내용>`, `--mcp-config data/mcp/<uuid>.json`, `--strict-mcp-config`, `--allowedTools mcp__fleet__request_decision`. 새 세션은 `--session-id <uuid>`, 이어가기는 `--resume <uuid>`.
- **tmux/claude 실행은 셸 문자열 금지 — argv 배열로 `spawn`/`execFileSync`** (따옴표/`$()` 이스케이프 회피). fleet-rule은 `readFileSync`로 읽어 인자 전달.
- `data/`(projects.json, sessions.json, mcp/*.json)는 gitignore됨.
- repoRoot = `/Users/kimjihun/Desktop/claude-fleet`, orchUrl = `http://127.0.0.1:4179`.
- DRY / YAGNI / TDD / 잦은 커밋.

---

## 파일 구조

```
src/
  types.ts             # (수정) SessionEntry, ProjectEntry, SessionStatus 추가 (Task 1)
  sessionStore.ts      # (신규) projects/sessions 영속 + 쿼리, tmux 없음 (Task 1)
  sessionManager.ts    # (신규) launch/resume/close/openTerminal/reconcile + CommandRunner + HttpError (Task 2)
  webServer.ts         # (수정) /api/projects, /api/sessions*, /internal/notify, 결정 enrich (Task 3)
  cli.ts               # (신규) fleet new/ls/resume/kill/attach/project add (Task 4)
  server.ts            # (수정) SessionManager 조립 + reconcile 폴링 + 부팅 reconcile (Task 6)
public/
  index.html           # (수정) 세션 목록 뷰 + notice 배지 + 카드에 프로젝트/세션 라벨 (Task 5)
docs/
  BOOTSTRAP.md         # (수정) Phase 2 사용법 + fleet alias + Notification 훅 (Task 6)
tests/
  sessionStore.test.ts     # (Task 1)
  sessionManager.test.ts   # (Task 2)
  webServerSessions.test.ts# (Task 3)
  cli.test.ts              # (Task 4)
```

---

## Task 1: SessionStore (projects/sessions 영속 + 쿼리)

**Files:**
- Modify: `src/types.ts`
- Create: `src/sessionStore.ts`, `tests/sessionStore.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `SessionStatus = "running" | "stopped"`
  - `SessionEntry { id, project, projectPath, tmuxName, status: SessionStatus, startedAt, lastSeen }`
  - `ProjectEntry { name, path }`
  - `class SessionStore(sessionsPath, projectsPath, now?)` with `listProjects()`, `getProject(name)`, `addProject(name,path)`, `listSessions()`, `getSession(id)`, `runningCount(project)`, `upsert(entry)`, `setStatus(id,status)`.

- [ ] **Step 1: 타입 추가 (src/types.ts 끝에 append)**

```ts
export type SessionStatus = "running" | "stopped";

export interface SessionEntry {
  id: string; // uuid = claude session id = fleet token
  project: string;
  projectPath: string;
  tmuxName: string;
  status: SessionStatus;
  startedAt: string;
  lastSeen: string;
}

export interface ProjectEntry {
  name: string;
  path: string;
}
```

- [ ] **Step 2: 실패 테스트 작성 (tests/sessionStore.test.ts)**

```ts
import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/sessionStore.js";
import type { SessionEntry } from "../src/types.js";

function newStore() {
  const dir = mkdtempSync(join(tmpdir(), "fleet-sess-"));
  return new SessionStore(join(dir, "sessions.json"), join(dir, "projects.json"), () => "2026-07-21T00:00:00.000Z");
}
function entry(over: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: "id1", project: "daggle", projectPath: "/p/daggle",
    tmuxName: "fleet__daggle__id1", status: "running",
    startedAt: "2026-07-21T00:00:00.000Z", lastSeen: "2026-07-21T00:00:00.000Z", ...over,
  };
}

test("missing files read as empty", () => {
  const s = newStore();
  expect(s.listProjects()).toEqual([]);
  expect(s.listSessions()).toEqual([]);
});

test("addProject then listProjects/getProject", () => {
  const s = newStore();
  s.addProject("daggle", "/p/daggle");
  expect(s.listProjects()).toEqual([{ name: "daggle", path: "/p/daggle" }]);
  expect(s.getProject("daggle")).toEqual({ name: "daggle", path: "/p/daggle" });
  expect(s.getProject("nope")).toBeUndefined();
});

test("upsert inserts then updates by id; getSession", () => {
  const s = newStore();
  s.upsert(entry());
  expect(s.listSessions()).toHaveLength(1);
  s.upsert(entry({ status: "stopped" }));
  expect(s.listSessions()).toHaveLength(1);
  expect(s.getSession("id1")!.status).toBe("stopped");
});

test("runningCount counts only running for that project", () => {
  const s = newStore();
  s.upsert(entry({ id: "a", status: "running" }));
  s.upsert(entry({ id: "b", status: "running" }));
  s.upsert(entry({ id: "c", status: "stopped" }));
  s.upsert(entry({ id: "d", project: "printtie", status: "running" }));
  expect(s.runningCount("daggle")).toBe(2);
  expect(s.runningCount("printtie")).toBe(1);
});

test("setStatus updates status + lastSeen; unknown id returns undefined", () => {
  const s = newStore();
  s.upsert(entry({ lastSeen: "old" }));
  const r = s.setStatus("id1", "stopped");
  expect(r!.status).toBe("stopped");
  expect(r!.lastSeen).toBe("2026-07-21T00:00:00.000Z");
  expect(s.setStatus("nope", "stopped")).toBeUndefined();
});

test("persistence: a new store instance reads the same files", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-persist-"));
  const p = join(dir, "projects.json"), ss = join(dir, "sessions.json");
  const a = new SessionStore(ss, p);
  a.addProject("daggle", "/p/daggle");
  a.upsert(entry());
  const b = new SessionStore(ss, p);
  expect(b.listProjects()).toHaveLength(1);
  expect(b.getSession("id1")).toBeTruthy();
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npm test -- sessionStore`
Expected: FAIL — `Cannot find module '../src/sessionStore.js'`.

- [ ] **Step 4: 구현 (src/sessionStore.ts)**

```ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionEntry, ProjectEntry, SessionStatus } from "./types.js";

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

export class SessionStore {
  constructor(
    private sessionsPath: string,
    private projectsPath: string,
    private now: () => string = () => new Date().toISOString(),
  ) {}

  listProjects(): ProjectEntry[] {
    const map = readJson<Record<string, { path: string }>>(this.projectsPath, {});
    return Object.entries(map).map(([name, v]) => ({ name, path: v.path }));
  }
  getProject(name: string): ProjectEntry | undefined {
    return this.listProjects().find((p) => p.name === name);
  }
  addProject(name: string, path: string): ProjectEntry {
    const map = readJson<Record<string, { path: string }>>(this.projectsPath, {});
    map[name] = { path };
    writeJson(this.projectsPath, map);
    return { name, path };
  }

  listSessions(): SessionEntry[] {
    return readJson<SessionEntry[]>(this.sessionsPath, []);
  }
  getSession(id: string): SessionEntry | undefined {
    return this.listSessions().find((s) => s.id === id);
  }
  runningCount(project: string): number {
    return this.listSessions().filter((s) => s.project === project && s.status === "running").length;
  }
  upsert(entry: SessionEntry): void {
    const all = this.listSessions();
    const i = all.findIndex((s) => s.id === entry.id);
    if (i >= 0) all[i] = entry;
    else all.push(entry);
    writeJson(this.sessionsPath, all);
  }
  setStatus(id: string, status: SessionStatus): SessionEntry | undefined {
    const all = this.listSessions();
    const s = all.find((x) => x.id === id);
    if (!s) return undefined;
    s.status = status;
    s.lastSeen = this.now();
    writeJson(this.sessionsPath, all);
    return s;
  }
}
```

- [ ] **Step 5: 통과 확인**

Run: `npm test -- sessionStore`
Expected: 6개 PASS.

- [ ] **Step 6: 커밋**

```bash
git add src/types.ts src/sessionStore.ts tests/sessionStore.test.ts
git commit -m "feat: SessionStore for project/session registry persistence"
```

---

## Task 2: SessionManager (launch/resume/close/openTerminal/reconcile)

**Files:**
- Create: `src/sessionManager.ts`, `tests/sessionManager.test.ts`

**Interfaces:**
- Consumes: `SessionStore` (Task 1), `SessionEntry`.
- Produces:
  - `interface CommandRunner { run(cmd: string, args: string[]): string }`
  - `class HttpError extends Error { status: number }`
  - `interface SessionManagerOpts { store, runner, repoRoot, orchUrl, mcpDir, ruleText, now?, genId? }`
  - `class SessionManager(opts)` with `launch(project): SessionEntry`, `resume(id): SessionEntry`, `close(id): SessionEntry`, `openTerminal(id): void`, `reconcile(): void`, and read-through `get store(): SessionStore`.

- [ ] **Step 1: 실패 테스트 작성 (tests/sessionManager.test.ts)**

```ts
import { expect, test } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/sessionStore.js";
import { SessionManager, HttpError, type CommandRunner } from "../src/sessionManager.js";

class FakeRunner implements CommandRunner {
  calls: Array<{ cmd: string; args: string[] }> = [];
  listOutput = "";
  failKeys = new Set<string>();
  run(cmd: string, args: string[]): string {
    this.calls.push({ cmd, args });
    const sub = args[0];
    if (this.failKeys.has(sub)) throw new Error(`fake fail ${sub}`);
    if (cmd === "tmux" && sub === "list-sessions") return this.listOutput;
    return "";
  }
}

function setup(projects: Record<string, string> = { daggle: "/p/daggle" }) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-mgr-"));
  const store = new SessionStore(join(dir, "sessions.json"), join(dir, "projects.json"), () => "2026-07-21T00:00:00.000Z");
  for (const [n, p] of Object.entries(projects)) store.addProject(n, p);
  const runner = new FakeRunner();
  let seq = 0;
  const mgr = new SessionManager({
    store, runner, repoRoot: "/repo", orchUrl: "http://127.0.0.1:4179",
    mcpDir: join(dir, "mcp"), ruleText: "RULE",
    now: () => "2026-07-21T00:00:00.000Z", genId: () => `uuid${++seq}0000`,
  });
  return { store, runner, mgr, dir };
}

test("launch: writes mcp config, runs tmux new-session with claude --session-id, registers running", () => {
  const { store, runner, mgr, dir } = setup();
  const e = mgr.launch("daggle");
  expect(e.status).toBe("running");
  expect(e.project).toBe("daggle");
  expect(e.tmuxName).toBe("fleet__daggle__uuid10"); // slug + first6 of "uuid10000"
  // mcp config written
  const cfgPath = join(dir, "mcp", `${e.id}.json`);
  expect(existsSync(cfgPath)).toBe(true);
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  expect(cfg.mcpServers.fleet.env.FLEET_SESSION_TOKEN).toBe(e.id);
  // tmux call
  const call = runner.calls.find((c) => c.cmd === "tmux" && c.args[0] === "new-session")!;
  expect(call.args).toEqual([
    "new-session", "-d", "-s", "fleet__daggle__uuid10", "-c", "/p/daggle",
    "claude", "--session-id", e.id,
    "--permission-mode", "acceptEdits",
    "--append-system-prompt", "RULE",
    "--mcp-config", cfgPath,
    "--strict-mcp-config",
    "--allowedTools", "mcp__fleet__request_decision",
  ]);
  expect(store.getSession(e.id)!.status).toBe("running");
});

test("launch unknown project throws HttpError 400", () => {
  const { mgr } = setup();
  expect(() => mgr.launch("nope")).toThrowError(expect.objectContaining({ status: 400 }));
});

test("launch rejected with 409 when 2 already running", () => {
  const { mgr } = setup();
  mgr.launch("daggle");
  mgr.launch("daggle");
  try {
    mgr.launch("daggle");
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(409);
  }
});

test("close: kills tmux and sets stopped; missing -> 404; kill error swallowed", () => {
  const { store, runner, mgr } = setup();
  const e = mgr.launch("daggle");
  const closed = mgr.close(e.id);
  expect(closed.status).toBe("stopped");
  expect(runner.calls.some((c) => c.args[0] === "kill-session" && c.args.includes(e.tmuxName))).toBe(true);
  expect(() => mgr.close("nope")).toThrowError(expect.objectContaining({ status: 404 }));
  // kill error swallowed
  runner.failKeys.add("kill-session");
  const e2 = mgr.launch("daggle");
  expect(() => mgr.close(e2.id)).not.toThrow();
  expect(store.getSession(e2.id)!.status).toBe("stopped");
});

test("resume: stopped -> new-session with --resume, running; running -> 409", () => {
  const { runner, mgr } = setup();
  const e = mgr.launch("daggle");
  mgr.close(e.id);
  runner.calls.length = 0;
  const r = mgr.resume(e.id);
  expect(r.status).toBe("running");
  const call = runner.calls.find((c) => c.args[0] === "new-session")!;
  expect(call.args).toContain("--resume");
  expect(call.args).toContain(e.id);
  expect(call.args).not.toContain("--session-id");
  expect(() => mgr.resume(e.id)).toThrowError(expect.objectContaining({ status: 409 }));
  expect(() => mgr.resume("nope")).toThrowError(expect.objectContaining({ status: 404 }));
});

test("reconcile: running sessions absent from tmux list become stopped", () => {
  const { store, runner, mgr } = setup();
  const a = mgr.launch("daggle");
  const b = mgr.launch("daggle");
  // only a is alive in tmux
  runner.listOutput = `${a.tmuxName}\nother-unrelated\n`;
  mgr.reconcile();
  expect(store.getSession(a.id)!.status).toBe("running");
  expect(store.getSession(b.id)!.status).toBe("stopped");
});

test("reconcile: tmux server down (list-sessions errors) marks all running stopped", () => {
  const { store, runner, mgr } = setup();
  const a = mgr.launch("daggle");
  runner.failKeys.add("list-sessions");
  mgr.reconcile();
  expect(store.getSession(a.id)!.status).toBe("stopped");
});

test("openTerminal runs osascript for the session; missing -> 404", () => {
  const { runner, mgr } = setup();
  const e = mgr.launch("daggle");
  mgr.openTerminal(e.id);
  expect(runner.calls.some((c) => c.cmd === "osascript" && c.args.join(" ").includes(e.tmuxName))).toBe(true);
  expect(() => mgr.openTerminal("nope")).toThrowError(expect.objectContaining({ status: 404 }));
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test -- sessionManager`
Expected: FAIL — `Cannot find module '../src/sessionManager.js'`.

- [ ] **Step 3: 구현 (src/sessionManager.ts)**

```ts
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { SessionStore } from "./sessionStore.js";
import type { SessionEntry } from "./types.js";

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
  now?: () => string;
  genId?: () => string;
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
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
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- sessionManager`
Expected: 8개 PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/sessionManager.ts tests/sessionManager.test.ts
git commit -m "feat: SessionManager for tmux session lifecycle via injectable runner"
```

---

## Task 3: HTTP 세션 엔드포인트 + 결정 enrich + notify

**Files:**
- Modify: `src/webServer.ts`
- Create: `tests/webServerSessions.test.ts`

**Interfaces:**
- Consumes: `SessionManager` (Task 2), `DecisionStore` (Phase 1).
- Produces (HTTP, 토큰 가드 대상은 `/api/*`):
  - `GET /api/projects` → `ProjectEntry[]`; `POST /api/projects {name,path}` → `{ok:true}`.
  - `GET /api/sessions` → `SessionEntry[]` 각 항목에 `notice` 병합(`{message,at}|null`).
  - `POST /api/sessions {project}` → `SessionEntry`(201) / `HttpError.status`.
  - `POST /api/sessions/:id/(resume|close|open-terminal)` → 결과/에러.
  - `GET /api/decisions` → 각 결정에 `session: {project,tmuxName}|null` 병합.
  - `POST /internal/notify {sessionId,message}` (토큰 없음) → notice 저장. `/internal/decisions` 생성 시 해당 sessionToken notice 삭제.
- `createServer(store, opts)`의 `opts`에 선택적 `sessions?: SessionManager` 추가(없으면 세션 엔드포인트는 404, Phase 1 테스트 영향 없음).

- [ ] **Step 1: 실패 테스트 작성 (tests/webServerSessions.test.ts)**

```ts
import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { DecisionStore } from "../src/decisionStore.js";
import { SessionStore } from "../src/sessionStore.js";
import { SessionManager, type CommandRunner } from "../src/sessionManager.js";
import { createServer } from "../src/webServer.js";

const TOKEN = "secret";

class FakeRunner implements CommandRunner {
  listOutput = "";
  run(cmd: string, args: string[]): string {
    if (cmd === "tmux" && args[0] === "list-sessions") return this.listOutput;
    return "";
  }
}

function boot() {
  const dir = mkdtempSync(join(tmpdir(), "fleet-web2-"));
  const decisions = new DecisionStore(join(dir, "h.jsonl"));
  const store = new SessionStore(join(dir, "sessions.json"), join(dir, "projects.json"));
  store.addProject("daggle", "/p/daggle");
  const runner = new FakeRunner();
  let seq = 0;
  const sessions = new SessionManager({
    store, runner, repoRoot: "/repo", orchUrl: "http://127.0.0.1:4179",
    mcpDir: join(dir, "mcp"), ruleText: "RULE", genId: () => `uuid${++seq}0000`,
  });
  const server = createServer(decisions, { panelToken: TOKEN, publicDir: join(dir, "public"), sessions });
  return new Promise<{ base: string; decisions: DecisionStore; sessions: SessionManager; close: () => void }>((res) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      res({ base: `http://127.0.0.1:${port}`, decisions, sessions, close: () => server.close() });
    });
  });
}
const q = (base: string, p: string) => `${base}${p}${p.includes("?") ? "&" : "?"}token=${TOKEN}`;

test("GET /api/projects returns registered projects (token-guarded)", async () => {
  const { base, close } = await boot();
  expect((await fetch(`${base}/api/projects`)).status).toBe(401);
  const r = await fetch(q(base, "/api/projects"));
  expect(await r.json()).toEqual([{ name: "daggle", path: "/p/daggle" }]);
  close();
});

test("POST /api/sessions launches; 3rd is 409; GET lists them", async () => {
  const { base, close } = await boot();
  const a = await (await fetch(q(base, "/api/sessions"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "daggle" }) })).json();
  expect(a.status).toBe("running");
  await fetch(q(base, "/api/sessions"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "daggle" }) });
  const third = await fetch(q(base, "/api/sessions"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "daggle" }) });
  expect(third.status).toBe(409);
  const list = await (await fetch(q(base, "/api/sessions"))).json();
  expect(list).toHaveLength(2);
  expect(list[0]).toHaveProperty("notice"); // null when none
  close();
});

test("POST /api/sessions unknown project -> 400", async () => {
  const { base, close } = await boot();
  const r = await fetch(q(base, "/api/sessions"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "nope" }) });
  expect(r.status).toBe(400);
  close();
});

test("close then resume via endpoints", async () => {
  const { base, close } = await boot();
  const a = await (await fetch(q(base, "/api/sessions"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "daggle" }) })).json();
  const c = await fetch(q(base, `/api/sessions/${a.id}/close`), { method: "POST" });
  expect((await c.json()).status).toBe("stopped");
  const r = await fetch(q(base, `/api/sessions/${a.id}/resume`), { method: "POST" });
  expect((await r.json()).status).toBe("running");
  close();
});

test("GET /api/decisions enriches with session {project,tmuxName}; /internal/notify sets+clears notice", async () => {
  const { base, decisions, sessions, close } = await boot();
  const a = await (await fetch(q(base, "/api/sessions"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "daggle" }) })).json();
  // a stuck notice
  await fetch(`${base}/internal/notify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: a.id, message: "waiting on perm" }) });
  let list = await (await fetch(q(base, "/api/sessions"))).json();
  expect(list.find((s: any) => s.id === a.id).notice.message).toBe("waiting on perm");
  // a decision from that session (fire, don't await)
  fetch(`${base}/internal/decisions`, { method: "POST", headers: { "content-type": "application/json", "x-fleet-session": a.id }, body: JSON.stringify({ title: "t", why_now: "w", payoff: "p", tradeoff: "tr", options: [{ n: 1, label: "x" }], allow_freetext: true }) }).catch(() => {});
  let pend: any[] = [];
  for (let i = 0; i < 50 && pend.length === 0; i++) { pend = await (await fetch(q(base, "/api/decisions"))).json(); if (!pend.length) await new Promise((r) => setTimeout(r, 10)); }
  expect(pend[0].session).toEqual({ project: "daggle", tmuxName: a.tmuxName });
  // creating the decision cleared the stuck notice
  list = await (await fetch(q(base, "/api/sessions"))).json();
  expect(list.find((s: any) => s.id === a.id).notice).toBeNull();
  // clean up the held request
  decisions.answer(pend[0].id, { choice: 1 });
  close();
  void sessions;
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test -- webServerSessions`
Expected: FAIL (routes not implemented / `sessions` opt unused).

- [ ] **Step 3: webServer.ts 수정**

Add imports at top:
```ts
import type { SessionManager } from "./sessionManager.js";
import { HttpError } from "./sessionManager.js";
```
Change the `createServer` signature and add a notices map + helpers. Replace the function header and internal/api blocks as follows (keep the static-file block and outer try/catch unchanged):

```ts
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
      return { ...d, session: s ? { project: s.project, tmuxName: s.tmuxName } : null };
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
        const sm = path.match(/^\/api\/sessions\/([^/]+)\/(resume|close|open-terminal)$/);
        if (sm && method === "POST") {
          if (!sessions) return send(res, 404, { error: "sessions disabled" });
          try {
            const id = sm[1];
            if (sm[2] === "resume") return send(res, 200, sessions.resume(id));
            if (sm[2] === "close") return send(res, 200, sessions.close(id));
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
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- webServerSessions` then `npm test`
Expected: 새 5개 PASS, 전체(Phase 1 포함) 그린. `npm run typecheck` 클린.

- [ ] **Step 5: 커밋**

```bash
git add src/webServer.ts tests/webServerSessions.test.ts
git commit -m "feat: session/project http endpoints, decision enrichment, notify"
```

---

## Task 4: CLI (`fleet`)

**Files:**
- Create: `src/cli.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: HTTP API (Task 3).
- Produces:
  - `resolveCommand(argv: string[]): CliAction` where `CliAction` is one of:
    - `{ kind: "http"; method: "GET" | "POST"; path: string; body?: unknown; render?: "sessions" | "projects" }`
    - `{ kind: "attach"; name: string }` (needs a session id→name lookup at run time — see below)
    - `{ kind: "error"; message: string }`
  - a `main()` that executes the action (fetch or `execFileSync("tmux", ["attach","-t",name], {stdio:"inherit"})`), reading `FLEET_URL`/`FLEET_PANEL_TOKEN` from env.

Note: `attach` needs the tmuxName for an id; `resolveCommand` returns `{kind:"attach-id", id}` and `main()` GETs `/api/sessions`, finds the entry, then execs tmux. Keep `resolveCommand` pure (map argv→intent); do the lookup in `main()`.

- [ ] **Step 1: 실패 테스트 작성 (tests/cli.test.ts)**

```ts
import { expect, test } from "vitest";
import { resolveCommand } from "../src/cli.js";

test("new <project> -> POST /api/sessions", () => {
  expect(resolveCommand(["new", "daggle"])).toEqual({ kind: "http", method: "POST", path: "/api/sessions", body: { project: "daggle" } });
});
test("ls -> GET /api/sessions with render", () => {
  expect(resolveCommand(["ls"])).toEqual({ kind: "http", method: "GET", path: "/api/sessions", render: "sessions" });
});
test("resume <id> -> POST resume", () => {
  expect(resolveCommand(["resume", "abc"])).toEqual({ kind: "http", method: "POST", path: "/api/sessions/abc/resume" });
});
test("kill <id> -> POST close", () => {
  expect(resolveCommand(["kill", "abc"])).toEqual({ kind: "http", method: "POST", path: "/api/sessions/abc/close" });
});
test("attach <id> -> attach-id", () => {
  expect(resolveCommand(["attach", "abc"])).toEqual({ kind: "attach-id", id: "abc" });
});
test("project add <name> <path> -> POST /api/projects", () => {
  expect(resolveCommand(["project", "add", "daggle", "/p/daggle"])).toEqual({ kind: "http", method: "POST", path: "/api/projects", body: { name: "daggle", path: "/p/daggle" } });
});
test("unknown / missing args -> error", () => {
  expect(resolveCommand(["new"]).kind).toBe("error");
  expect(resolveCommand(["bogus"]).kind).toBe("error");
  expect(resolveCommand([]).kind).toBe("error");
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test -- cli`
Expected: FAIL — `Cannot find module '../src/cli.js'`.

- [ ] **Step 3: 구현 (src/cli.ts)**

```ts
import { execFileSync } from "node:child_process";

export type CliAction =
  | { kind: "http"; method: "GET" | "POST"; path: string; body?: unknown; render?: "sessions" | "projects" }
  | { kind: "attach-id"; id: string }
  | { kind: "error"; message: string };

export function resolveCommand(argv: string[]): CliAction {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "new":
      if (!rest[0]) return { kind: "error", message: "usage: fleet new <project>" };
      return { kind: "http", method: "POST", path: "/api/sessions", body: { project: rest[0] } };
    case "ls":
      return { kind: "http", method: "GET", path: "/api/sessions", render: "sessions" };
    case "resume":
      if (!rest[0]) return { kind: "error", message: "usage: fleet resume <id>" };
      return { kind: "http", method: "POST", path: `/api/sessions/${rest[0]}/resume` };
    case "kill":
      if (!rest[0]) return { kind: "error", message: "usage: fleet kill <id>" };
      return { kind: "http", method: "POST", path: `/api/sessions/${rest[0]}/close` };
    case "attach":
      if (!rest[0]) return { kind: "error", message: "usage: fleet attach <id>" };
      return { kind: "attach-id", id: rest[0] };
    case "project":
      if (rest[0] === "add" && rest[1] && rest[2]) {
        return { kind: "http", method: "POST", path: "/api/projects", body: { name: rest[1], path: rest[2] } };
      }
      return { kind: "error", message: "usage: fleet project add <name> <path>" };
    default:
      return { kind: "error", message: `unknown command: ${cmd ?? "(none)"}\nfleet new|ls|resume|kill|attach|project add` };
  }
}

const ORCH = process.env.FLEET_URL ?? "http://127.0.0.1:4179";
const TOKEN = process.env.FLEET_PANEL_TOKEN ?? "";

function withToken(path: string): string {
  return `${ORCH}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}`;
}

async function apiSessions(): Promise<Array<{ id: string; tmuxName: string }>> {
  return (await (await fetch(withToken("/api/sessions"))).json()) as Array<{ id: string; tmuxName: string }>;
}

async function main(): Promise<void> {
  const action = resolveCommand(process.argv.slice(2));
  if (action.kind === "error") {
    console.error(action.message);
    process.exit(1);
  }
  if (action.kind === "attach-id") {
    const s = (await apiSessions()).find((x) => x.id === action.id || x.tmuxName.endsWith(action.id));
    if (!s) {
      console.error(`no session ${action.id}`);
      process.exit(1);
    }
    execFileSync("tmux", ["attach", "-t", s.tmuxName], { stdio: "inherit" });
    return;
  }
  const res = await fetch(withToken(action.path), {
    method: action.method,
    headers: action.body ? { "content-type": "application/json" } : {},
    body: action.body ? JSON.stringify(action.body) : undefined,
  });
  const data = await res.json();
  if (action.render === "sessions" && Array.isArray(data)) {
    for (const s of data as Array<Record<string, string>>) {
      const notice = (s as any).notice ? "  ⚠️" : "";
      console.log(`${s.status === "running" ? "●" : "○"} ${s.project.padEnd(12)} ${s.tmuxName}  ${s.id}${notice}`);
    }
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
  if (!res.ok) process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith("cli.ts")) {
  void main();
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- cli`
Expected: 7개 PASS. (main/fetch/exec는 실제 서버 필요 → 수동; resolveCommand만 단위 검증)

- [ ] **Step 5: 커밋**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat: fleet CLI (new/ls/resume/kill/attach/project add)"
```

---

## Task 5: 패널 세션 뷰 + notice 배지 + 결정 라벨

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `GET /api/sessions`, `GET /api/projects`, `POST /api/sessions*` (Task 3), enriched `/api/decisions`.
- Produces: 패널에 (1) 결정 카드(기존, 이제 프로젝트/세션 라벨 표시), (2) **세션 목록 뷰**(프로젝트별 running/stopped + 버튼: 새 세션 / resume / 닫기 / 맥에서 열기), notice 배지.

- [ ] **Step 1: index.html 수정**

기존 `<style>`에 아래 규칙 추가(닫는 `</style>` 앞):
```css
  .sessions { max-width: 620px; margin: 16px auto 0; }
  .proj { margin-bottom: 14px; }
  .proj h3 { font-size: 13px; color: #8a929b; margin: 0 0 6px; text-transform: uppercase; letter-spacing: .06em; }
  .srow { display: flex; align-items: center; gap: 8px; background: #16191d; border-radius: 10px; padding: 10px 12px; margin-bottom: 6px; }
  .srow .dot { font-size: 10px; }
  .srow .name { flex: 1; font-size: 13px; color: #c7ccd1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .srow button { border: 0; border-radius: 8px; background: #23272e; color: #e8eaed; padding: 6px 10px; font-size: 12px; cursor: pointer; }
  .srow button.kill { background: #3a1e1e; color: #f0a; }
  .srow .badge { color: #f5a623; font-size: 12px; }
  .newbtn { background: #1e2f22 !important; color: #7ee2a8 !important; }
  .card .who { font-size: 12px; color: #7ee2a8; margin: -8px 0 12px; }
```
In the card render (index.html `render()`), add a session label line right after the title `<p class="title">`:
```js
        ${item.session ? `<p class="who">▸ ${esc(item.session.project)} · ${esc(item.session.tmuxName)}</p>` : ""}
```
Add a second root container after `<div id="root">…</div>` in the body:
```html
<div id="sessions" class="sessions"></div>
```
Add JS (before `poll();` at the end) to poll + render sessions:
```js
  async function pollSessions() {
    try {
      const [projects, sessions] = await Promise.all([
        fetch(q("/api/projects")).then((r) => r.json()),
        fetch(q("/api/sessions")).then((r) => r.json()),
      ]);
      renderSessions(projects, sessions);
    } catch (e) { /* retry next tick */ }
    setTimeout(pollSessions, 2000);
  }
  function renderSessions(projects, sessions) {
    const el = document.getElementById("sessions");
    el.innerHTML = projects.map((p) => {
      const rows = sessions.filter((s) => s.project === p.name).map((s) => {
        const running = s.status === "running";
        const badge = s.notice ? `<span class="badge" title="${esc(s.notice.message)}">⚠️</span>` : "";
        const btns = running
          ? `<button data-act="open" data-id="${esc(s.id)}">맥에서 열기</button><button class="kill" data-act="close" data-id="${esc(s.id)}">닫기</button>`
          : `<button data-act="resume" data-id="${esc(s.id)}">resume</button>`;
        return `<div class="srow"><span class="dot">${running ? "🟢" : "⚪️"}</span><span class="name">${esc(s.tmuxName)}</span>${badge}${btns}</div>`;
      }).join("");
      return `<div class="proj"><h3>${esc(p.name)}</h3>${rows}<div class="srow"><button class="newbtn" data-act="new" data-proj="${esc(p.name)}">+ 새 세션</button></div></div>`;
    }).join("");
    el.querySelectorAll("button[data-act]").forEach((b) => b.addEventListener("click", () => sessionAction(b.dataset)));
  }
  async function sessionAction(d) {
    if (d.act === "new") await fetch(q("/api/sessions"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: d.proj }) });
    else if (d.act === "resume") await fetch(q(`/api/sessions/${d.id}/resume`), { method: "POST" });
    else if (d.act === "close") await fetch(q(`/api/sessions/${d.id}/close`), { method: "POST" });
    else if (d.act === "open") await fetch(q(`/api/sessions/${d.id}/open-terminal`), { method: "POST" });
    pollSessions();
  }
```
And start it: change the final `poll();` to:
```js
  poll();
  pollSessions();
```

- [ ] **Step 2: 수동 확인**

터미널 A: `FLEET_PANEL_TOKEN=dev npm start` (Task 6 완료 후엔 세션 매니저 붙음; 이 태스크만 단독 확인하려면 임시로 sessions 옵션 없이도 페이지 로드/JS 에러 없음만 봐도 됨)
- `curl -s -X POST 'http://127.0.0.1:4179/api/projects?token=dev' -H 'content-type: application/json' -d '{"name":"demo","path":"/tmp/demo"}'`
- 브라우저 `http://127.0.0.1:4179/?token=dev` → "demo" 프로젝트와 "+ 새 세션" 버튼 보임(실제 launch는 Task 6 wiring 후 tmux 필요).
- 결정 시드(Phase 1 `scripts/seed-decision.ts`)로 카드에 세션 라벨 자리 확인(session 없으면 라벨 생략).

Expected: 페이지가 결정 카드 뷰 + 세션 뷰 둘 다 렌더, JS 콘솔 에러 없음.

- [ ] **Step 3: 커밋**

```bash
git add public/index.html
git commit -m "feat: panel session list view, notice badges, decision session label"
```

---

## Task 6: 서버 조립 + reconcile 폴링 + BOOTSTRAP + E2E

**Files:**
- Modify: `src/server.ts`, `docs/BOOTSTRAP.md`

**Interfaces:**
- Consumes: 전부(Task 1~5).
- Produces: 실행 시 오케스트레이터가 SessionManager를 조립하고, 부팅 직후 1회 + 주기(기본 5s) `reconcile()`를 돌린다. BOOTSTRAP에 Phase 2 사용법.

- [ ] **Step 1: src/server.ts 수정**

```ts
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { DecisionStore } from "./decisionStore.js";
import { SessionStore } from "./sessionStore.js";
import { SessionManager, type CommandRunner } from "./sessionManager.js";
import { createServer } from "./webServer.js";
import { CONFIG } from "./config.js";

const repoRoot = process.cwd();
const decisions = new DecisionStore(CONFIG.historyPath);
const sessionStore = new SessionStore(
  join(CONFIG.dataDir, "sessions.json"),
  join(CONFIG.dataDir, "projects.json"),
);
const realRunner: CommandRunner = {
  run: (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }),
};
const sessions = new SessionManager({
  store: sessionStore,
  runner: realRunner,
  repoRoot,
  orchUrl: `http://127.0.0.1:${CONFIG.port}`,
  mcpDir: join(CONFIG.dataDir, "mcp"),
  ruleText: readFileSync(join(repoRoot, "fleet-rule.txt"), "utf8"),
});

const publicDir = join(repoRoot, "public");
const server = createServer(decisions, { panelToken: CONFIG.panelToken, publicDir, sessions });

server.listen(CONFIG.port, () => {
  console.log(`fleet orchestrator on http://127.0.0.1:${CONFIG.port}`);
  console.log(`panel: http://127.0.0.1:${CONFIG.port}/?token=${CONFIG.panelToken}`);
  if (CONFIG.panelToken === "change-me-please") {
    console.warn("⚠️  FLEET_PANEL_TOKEN 기본값 사용 중 — 실제 토큰으로 교체하세요.");
  }
  sessions.reconcile(); // boot-time reconcile
  setInterval(() => {
    try {
      sessions.reconcile();
    } catch (e) {
      console.error("reconcile error:", e);
    }
  }, 5000);
});
```

- [ ] **Step 2: 실제 tmux 스모크 (claude 없이 — 쿼터 안 씀)**

`reconcile`/tmux 연동을 실제 tmux로 최소 검증한다(더미 세션, claude 미실행):
```bash
tmux new-session -d -s fleet__smoke__aaaaaa "sleep 60"
tmux list-sessions -F '#{session_name}' | grep fleet__smoke__aaaaaa   # 있으면 tmux 연동 OK
tmux kill-session -t fleet__smoke__aaaaaa
tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -c fleet__smoke__aaaaaa || echo "gone(0) = reconcile가 stopped로 볼 것"
```
Expected: 생성 시 grep 매치, kill 후 0(=reconcile 폴링이 stopped로 전이). SessionManager.reconcile는 Task 2에서 단위 검증됨 — 여기선 tmux 명령 자체가 이 맥에서 도는지만 확인.

- [ ] **Step 3: docs/BOOTSTRAP.md에 Phase 2 섹션 추가 (파일 끝에 append)**

````markdown
## Phase 2 — 세션 관리 (fleet)

### fleet CLI 별칭 (1회)
```bash
alias fleet='FLEET_PANEL_TOKEN=원하는-긴-토큰 tsx /Users/kimjihun/Desktop/claude-fleet/src/cli.ts'
```
(오케스트레이터를 같은 `FLEET_PANEL_TOKEN`으로 `npm start` 해둔다.)

### 프로젝트 등록 (1회)
```bash
fleet project add daggle /Users/kimjihun/work/daggle
fleet project add printtie /Users/kimjihun/work/printtie
```
또는 `data/projects.json` 직접 편집: `{ "daggle": { "path": "/…/daggle" } }`.

### 세션 관리
```bash
fleet new daggle        # 새 세션(프로젝트당 running 최대 2)
fleet ls                # 세션 목록(●=running ○=stopped, ⚠️=주목)
fleet attach <id>       # 맥에서 포그라운드로 (히스토리 그대로 보임; Ctrl-b d 로 떼기)
fleet kill <id>         # 닫기(tmux 종료, resume 가능하게 유지)
fleet resume <id>       # 닫힌 세션 대화 복원
```
패널(폰)에서도 같은 동작을 버튼으로: 프로젝트별 "+ 새 세션" / resume / 닫기 / 맥에서 열기.

### Notification 안전망 (선택)
세션이 request_decision이 아닌 네이티브 프롬프트에서 멈추면 패널에 ⚠️ 를 띄우려면, Claude Code Notification 훅에서 오케스트레이터로 POST 하도록 설정한다(세션의 `--settings` 또는 사용자 설정):
```jsonc
// hooks: Notification
// curl -s -X POST http://127.0.0.1:4179/internal/notify \
//   -H 'content-type: application/json' \
//   -d "{\"sessionId\":\"$FLEET_SESSION_ID\",\"message\":\"needs attention\"}"
```
(세션 id를 훅에 전달하는 정확한 변수는 Claude Code 훅 스펙에 맞춰 채운다.)
````

- [ ] **Step 4: 전체 검증 + 커밋**

Run:
```bash
npm test && npm run typecheck
```
Expected: 전체 테스트 그린(Phase 1+2), typecheck 클린.
```bash
git add src/server.ts docs/BOOTSTRAP.md
git commit -m "feat: wire session manager into server with reconcile loop; bootstrap docs"
```

- [ ] **Step 5: 수동 E2E (실제 claude — 사용자와 함께, 쿼터 사용)**

문서로만 남기고 실행은 사용자 몫(실제 claude 세션 + 폰 필요):
1. `FLEET_PANEL_TOKEN=… npm start` 후 `fleet project add …`.
2. `fleet new <proj>` → `fleet ls`에 running → 패널에 세션 표시.
3. 세션에 결정 유발 작업 → 카드에 "프로젝트·세션" 라벨과 함께 뜸 → 폰에서 답 → 세션 이어감.
4. `fleet kill` 또는 직접 `tmux kill-session` → 패널/`fleet ls` stopped 반영(≤5s).
5. `fleet resume <id>` → 대화 복원. `fleet attach <id>` → 히스토리 보임.

---

## Self-Review 결과

- **스펙 커버리지:** §4.1 projects.json→Task1/3, §4.2 sessions.json→Task1, §4.3 SessionManager(launch/resume/close/openTerminal/reconcile)→Task2, §4.4 실행커맨드/mcp config→Task2, §4.5 HTTP→Task3, §4.6 CLI→Task4, §4.7 reconcile 폴링→Task2(로직)+Task6(스케줄러), §4.8 다중세션 라우팅(결정 enrich)→Task3, §4.9 Notification→Task3(엔드포인트)+Task5(배지)+Task6(훅 문서), 패널 뷰→Task5, 완료기준 1~7→Task3 테스트 + Task6 E2E. 갭 없음.
- **플레이스홀더:** 없음(모든 코드/명령 실체). `<id>`/`<uuid>` 등은 런타임 값 표기.
- **타입 일관성:** `SessionEntry`/`ProjectEntry`/`SessionStatus`(Task1) ↔ `SessionManager`/`CommandRunner`/`HttpError`(Task2) ↔ webServer의 `sessions?: SessionManager`·`sessions.store`(Task3) ↔ CLI `CliAction`(Task4)이 일관. 세션 id=uuid=토큰=tmux 접미 통일이 launch(`--session-id`)/mcp env(`FLEET_SESSION_TOKEN`)/결정 enrich(`getSession(sessionToken)`)에서 동일 키로 사용됨.

## Phase 3 이후 (참고)
- 카드 풀스타일(mockup), 음성 입력(Web Speech API), 파일 첨부, 자동 저장, 결정/세션 히스토리 UI, 여러 카드 스택 UX 정교화.
