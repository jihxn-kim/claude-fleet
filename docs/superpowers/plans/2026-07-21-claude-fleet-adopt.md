# Claude 함대 컨트롤 — adopt(기존 세션 데려오기) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** fleet가 만들지 않은 기존 claude 대화를 session id로 fleet 관리 하에 `--resume` 시켜 데려온다(히스토리 유지 + 패널 결정 활성). 그리고 id를 찾도록 프로젝트별 기존 세션을 나열한다(discover).

**Design (요약):**
- claude는 세션을 `~/.claude/projects/<경로인코딩>/<session-id>.jsonl` 로 저장. 경로 인코딩 = 경로의 `/`와 `.`를 모두 `-`로 치환(검증됨).
- **discover(project)**: 등록된 프로젝트 경로 → 인코딩 폴더의 `*.jsonl` 나열 → 각 {id, 마지막활동 mtime, 첫 user 메시지 스니펫}.
- **adopt(id, project)**: 그 id로 fleet 레지스트리 새 엔트리 + mcp config + `tmux new-session … claude --resume <id>`(프로젝트 경로에서) → running. resume와 거의 같되 id가 레지스트리에 없어도 되고 세션 파일 존재를 검증.
- ⚠️ 안전: 데려올 세션이 다른 곳에서 실행 중이면 안 됨(같은 id 중복). 원 터미널 먼저 닫기 — 문서/패널 안내로만(자동감지 안 함).

**Tech Stack:** 기존 Node 24 + TS(ESM/NodeNext) + tsx + vitest. 신규 의존성 없음(`node:fs`/`node:os`).

## Global Constraints

- ESM `.js` 상대 import. `npm run typecheck` 클린 유지. 빌드 없음.
- 세션 id = claude session id = fleet 토큰 = tmux 접미(기존 불변식 그대로). adopt는 **주어진 기존 id를 그대로** fleet id로 씀.
- 프로젝트당 running 최대 2 강제(adopt도 포함). unknown project → 400, 세션파일 없음 → 404, 이미 running인 id → 409, running 2개 → 409.
- 경로 인코딩: `path.replace(/[/.]/g, "-")`.
- adopt/discover는 기존 `writeMcpConfig`/`claudeArgv("--resume", …)`/`slug`을 재사용(DRY).
- `SessionManager`에 `claudeProjectsDir` 옵션 주입(테스트 격리용). server.ts 기본값 = `join(homedir(), ".claude/projects")`.
- TDD / 잦은 커밋.

---

## Task 1: SessionManager.discover + adopt

**Files:**
- Modify: `src/types.ts` (AvailableSession), `src/sessionManager.ts`
- Modify: `tests/sessionManager.test.ts`

**Interfaces:**
- Consumes: `SessionStore`, `SessionEntry`, 기존 SessionManager 내부(writeMcpConfig/claudeArgv/slug).
- Produces:
  - `AvailableSession { id: string; mtime: string; snippet: string }`
  - `SessionManagerOpts`에 `claudeProjectsDir: string` 추가.
  - `discover(project: string): AvailableSession[]` — 최신순.
  - `adopt(id: string, project: string): SessionEntry`.

- [ ] **Step 1: 타입 추가 (src/types.ts 끝에 append)**

```ts
export interface AvailableSession {
  id: string;
  mtime: string; // ISO, 세션 파일 최종 수정시각
  snippet: string; // 첫 user 메시지 일부
}
```

- [ ] **Step 2: 실패 테스트 작성 (tests/sessionManager.test.ts 에 append)**

기존 파일 상단 import에 `writeFileSync, mkdirSync`가 `node:fs`에서 오는지 확인하고 없으면 추가. 아래 테스트를 파일 끝에 추가:

```ts
import { writeFileSync as _wf, mkdirSync as _mk } from "node:fs";

function seedClaudeSession(claudeDir: string, projectPath: string, id: string, firstUser: string): void {
  const enc = projectPath.replace(/[/.]/g, "-");
  const dir = join(claudeDir, enc);
  _mk(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "mode", mode: "normal", sessionId: id }),
    JSON.stringify({ type: "user", message: { role: "user", content: firstUser } }),
  ].join("\n");
  _wf(join(dir, `${id}.jsonl`), lines);
}

test("discover lists sessions for a project's claude dir with id/mtime/snippet, newest first", () => {
  const { store, mgr, dir } = setup();
  const claudeDir = join(dir, "claude-projects");
  // re-make mgr with claudeProjectsDir pointed at our temp claude dir
  const mgr2 = new SessionManager({
    store, runner: (mgr as unknown as { o: { runner: CommandRunner } }).o.runner,
    repoRoot: "/repo", orchUrl: "http://127.0.0.1:4179", mcpDir: join(dir, "mcp"),
    ruleText: "RULE", claudeProjectsDir: claudeDir,
    now: () => "2026-07-21T00:00:00.000Z", genId: () => "unused",
  });
  seedClaudeSession(claudeDir, "/p/daggle", "11111111-aaaa", "첫 작업 요청 내용");
  const list = mgr2.discover("daggle");
  expect(list).toHaveLength(1);
  expect(list[0].id).toBe("11111111-aaaa");
  expect(list[0].snippet).toContain("첫 작업 요청");
  expect(typeof list[0].mtime).toBe("string");
});

test("discover on unknown project throws 400; empty when no claude dir", () => {
  const { store, mgr, dir } = setup();
  const mgr2 = new SessionManager({
    store, runner: (mgr as unknown as { o: { runner: CommandRunner } }).o.runner,
    repoRoot: "/repo", orchUrl: "http://127.0.0.1:4179", mcpDir: join(dir, "mcp"),
    ruleText: "RULE", claudeProjectsDir: join(dir, "nope-claude"),
  });
  expect(() => mgr2.discover("ghost")).toThrowError(expect.objectContaining({ status: 400 }));
  expect(mgr2.discover("daggle")).toEqual([]); // dir 없음 → 빈 배열
});

test("adopt registers the given id, resumes it, running", () => {
  const { store, dir } = setup();
  const runner = new FakeRunner();
  const claudeDir = join(dir, "claude-projects");
  const mgr = new SessionManager({
    store, runner, repoRoot: "/repo", orchUrl: "http://127.0.0.1:4179",
    mcpDir: join(dir, "mcp"), ruleText: "RULE", claudeProjectsDir: claudeDir,
    now: () => "2026-07-21T00:00:00.000Z",
  });
  seedClaudeSession(claudeDir, "/p/daggle", "22222222-bbbb", "이전 대화");
  const e = mgr.adopt("22222222-bbbb", "daggle");
  expect(e.id).toBe("22222222-bbbb");
  expect(e.status).toBe("running");
  expect(e.tmuxName).toBe("fleet__daggle__222222");
  const call = runner.calls.find((c) => c.args[0] === "new-session")!;
  expect(call.args).toContain("--resume");
  expect(call.args).toContain("22222222-bbbb");
  expect(call.args).not.toContain("--session-id");
  expect(store.getSession("22222222-bbbb")!.status).toBe("running");
});

test("adopt: unknown project 400, missing session file 404, id already running 409, max-2 409", () => {
  const { store, dir } = setup();
  const runner = new FakeRunner();
  const claudeDir = join(dir, "claude-projects");
  const mgr = new SessionManager({
    store, runner, repoRoot: "/repo", orchUrl: "http://127.0.0.1:4179",
    mcpDir: join(dir, "mcp"), ruleText: "RULE", claudeProjectsDir: claudeDir,
    now: () => "2026-07-21T00:00:00.000Z", genId: (() => { let n = 0; return () => `gen${++n}0000`; })(),
  });
  expect(() => mgr.adopt("x", "ghost")).toThrowError(expect.objectContaining({ status: 400 }));
  expect(() => mgr.adopt("no-file", "daggle")).toThrowError(expect.objectContaining({ status: 404 }));
  seedClaudeSession(claudeDir, "/p/daggle", "33333333-cccc", "hi");
  mgr.adopt("33333333-cccc", "daggle"); // running now
  expect(() => mgr.adopt("33333333-cccc", "daggle")).toThrowError(expect.objectContaining({ status: 409 })); // already running
  // fill to 2 running with fresh launches, then adopt a 3rd distinct file → 409 max-2
  seedClaudeSession(claudeDir, "/p/daggle", "44444444-dddd", "hi2");
  mgr.launch("daggle"); // 2 running (33.. + gen1)
  expect(() => mgr.adopt("44444444-dddd", "daggle")).toThrowError(expect.objectContaining({ status: 409 }));
});
```

- [ ] **Step 3: 실패 확인**

Run: `npm test -- sessionManager`
Expected: FAIL (discover/adopt 미구현, claudeProjectsDir 옵션 없음).

- [ ] **Step 4: 구현 (src/sessionManager.ts)**

상단 import를 확장:
```ts
import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync, readFileSync } from "node:fs";
```
`import type { SessionEntry } from "./types.js";` 를 `import type { SessionEntry, AvailableSession } from "./types.js";` 로 변경.

`SessionManagerOpts` 인터페이스에 필드 추가:
```ts
  claudeProjectsDir: string;
```

파일 하단(클래스 밖 `slug` 근처)에 헬퍼 추가:
```ts
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
```

클래스 안에 메서드 추가(예: `reconcile` 뒤):
```ts
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
```

- [ ] **Step 5: 통과 확인**

Run: `npm test -- sessionManager` then `npm test` then `npm run typecheck`
Expected: 새 4개 포함 전부 PASS, typecheck 클린.

- [ ] **Step 6: 커밋**

```bash
git add src/types.ts src/sessionManager.ts tests/sessionManager.test.ts
git commit -m "feat: SessionManager discover + adopt for external claude sessions"
```

---

## Task 2: HTTP 엔드포인트 + server 배선

**Files:**
- Modify: `src/webServer.ts`, `src/server.ts`
- Modify: `tests/webServerSessions.test.ts`

**Interfaces:**
- Consumes: SessionManager.discover/adopt (Task 1).
- Produces (토큰 가드):
  - `GET /api/projects/:name/available` → `AvailableSession[]`.
  - `POST /api/sessions/adopt {id, project}` → `SessionEntry`(201) / HttpError.status.
- server.ts는 SessionManager에 `claudeProjectsDir: join(homedir(), ".claude/projects")` 전달.

- [ ] **Step 1: 실패 테스트 작성 (tests/webServerSessions.test.ts 에 append)**

기존 `boot()` 헬퍼는 SessionManager를 만들 때 `claudeProjectsDir`가 없으면 typecheck가 깨진다 → boot() 안의 SessionManager 생성에 `claudeProjectsDir: join(dir, "claude-projects")` 를 추가하고, seed 헬퍼를 파일에 추가한다.

`boot()` 내 `new SessionManager({ … })` 에 아래 줄 추가:
```ts
    claudeProjectsDir: join(dir, "claude-projects"),
```
그리고 파일에 헬퍼 + 테스트 추가:
```ts
import { writeFileSync, mkdirSync } from "node:fs";

function seedSession(dir: string, projectPath: string, id: string, firstUser: string): void {
  const enc = projectPath.replace(/[/.]/g, "-");
  const d = join(dir, "claude-projects", enc);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${id}.jsonl`), JSON.stringify({ type: "user", message: { role: "user", content: firstUser } }));
}

test("GET /api/projects/:name/available lists discoverable sessions; adopt registers one", async () => {
  const { base, dir, close } = await boot();
  // daggle project registered at /p/daggle in boot(); seed a claude session there
  seedSession(dir, "/p/daggle", "aaaa1111-2222", "이전에 하던 작업");
  const avail = await (await fetch(q(base, "/api/projects/daggle/available"))).json();
  expect(avail).toHaveLength(1);
  expect(avail[0].id).toBe("aaaa1111-2222");

  const adopted = await fetch(q(base, "/api/sessions/adopt"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "aaaa1111-2222", project: "daggle" }),
  });
  expect(adopted.status).toBe(201);
  const body = await adopted.json();
  expect(body.id).toBe("aaaa1111-2222");
  expect(body.status).toBe("running");

  const list = await (await fetch(q(base, "/api/sessions"))).json();
  expect(list.some((s: { id: string }) => s.id === "aaaa1111-2222")).toBe(true);
  close();
});

test("adopt with missing session file → 404", async () => {
  const { base, close } = await boot();
  const r = await fetch(q(base, "/api/sessions/adopt"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "nope", project: "daggle" }),
  });
  expect(r.status).toBe(404);
  close();
});
```

`boot()`가 `dir`를 반환하지 않으면 반환 객체에 `dir`를 추가한다(테스트가 `dir`로 seed 하므로).

- [ ] **Step 2: 실패 확인**

Run: `npm test -- webServerSessions`
Expected: FAIL (엔드포인트 미구현 / boot의 claudeProjectsDir 필요).

- [ ] **Step 3: webServer.ts 라우트 추가**

`/api/` 가드 블록 안, 기존 sessions 라우트들 근처에 추가:
```ts
        const avail = path.match(/^\/api\/projects\/([^/]+)\/available$/);
        if (avail && method === "GET") {
          if (!sessions) return send(res, 404, { error: "sessions disabled" });
          try {
            return send(res, 200, sessions.discover(decodeURIComponent(avail[1])));
          } catch (e) {
            return sendHttpError(res, e);
          }
        }
        if (path === "/api/sessions/adopt" && method === "POST") {
          if (!sessions) return send(res, 404, { error: "sessions disabled" });
          try {
            const { id, project } = (await readJson(req)) as { id: string; project: string };
            return send(res, 201, sessions.adopt(id, project));
          } catch (e) {
            return sendHttpError(res, e);
          }
        }
```
주의: `POST /api/sessions/adopt` 라우트는 기존 `/^\/api\/sessions\/([^/]+)\/(resume|close|open-terminal)$/` 정규식보다 **먼저** 두거나, 정규식이 `adopt`를 안 잡으므로 순서 무관하지만, `/api/sessions` (POST launch) 라우트와 혼동되지 않게 `adopt` 체크를 `/api/sessions` POST(정확히 일치) 뒤에 둔다. (`path === "/api/sessions"` 는 정확 일치라 `/api/sessions/adopt`와 안 겹침.)

- [ ] **Step 4: server.ts 배선**

`import { readFileSync } from "node:fs";` 옆에 `homedir`를 추가:
```ts
import { homedir } from "node:os";
```
`new SessionManager({ … })` 옵션에 추가:
```ts
  claudeProjectsDir: join(homedir(), ".claude/projects"),
```

- [ ] **Step 5: 통과 확인**

Run: `npm test -- webServerSessions` then `npm test` then `npm run typecheck`
Expected: 새 2개 포함 전부 PASS, typecheck 클린.

- [ ] **Step 6: 커밋**

```bash
git add src/webServer.ts src/server.ts tests/webServerSessions.test.ts
git commit -m "feat: /api discover + adopt endpoints, wire claudeProjectsDir"
```

---

## Task 3: CLI (discover + adopt)

**Files:**
- Modify: `src/cli.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: 엔드포인트(Task 2).
- Produces: `resolveCommand`에 `discover`/`adopt` 케이스 + `render: "available"`.

- [ ] **Step 1: 실패 테스트 (tests/cli.test.ts 에 append)**

```ts
test("discover <project> -> GET available", () => {
  expect(resolveCommand(["discover", "daggle"])).toEqual({ kind: "http", method: "GET", path: "/api/projects/daggle/available", render: "available" });
});
test("adopt <id> <project> -> POST adopt", () => {
  expect(resolveCommand(["adopt", "abc-123", "daggle"])).toEqual({ kind: "http", method: "POST", path: "/api/sessions/adopt", body: { id: "abc-123", project: "daggle" } });
});
test("discover/adopt missing args -> error", () => {
  expect(resolveCommand(["discover"]).kind).toBe("error");
  expect(resolveCommand(["adopt", "onlyid"]).kind).toBe("error");
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- cli`
Expected: FAIL.

- [ ] **Step 3: cli.ts 수정**

`CliAction`의 `render`를 `"sessions" | "projects" | "available"` 로 확장. `resolveCommand`의 `switch`에 케이스 추가(default 앞):
```ts
    case "discover":
      if (!rest[0]) return { kind: "error", message: "usage: fleet discover <project>" };
      return { kind: "http", method: "GET", path: `/api/projects/${rest[0]}/available`, render: "available" };
    case "adopt":
      if (!rest[0] || !rest[1]) return { kind: "error", message: "usage: fleet adopt <session-id> <project>" };
      return { kind: "http", method: "POST", path: "/api/sessions/adopt", body: { id: rest[0], project: rest[1] } };
```
`main()`의 렌더 분기에 available 처리 추가(기존 `if (action.render === "sessions" …)` 뒤에):
```ts
  } else if (action.render === "available" && Array.isArray(data)) {
    if (data.length === 0) console.log("(가져올 세션 없음)");
    for (const a of data as Array<{ id: string; mtime: string; snippet: string }>) {
      console.log(`${a.id}  ${a.mtime.slice(0, 16).replace("T", " ")}  ${a.snippet || "(스니펫 없음)"}`);
    }
```
(위 `else if`가 기존 `} else {` 앞에 오도록 체이닝.)

- [ ] **Step 4: 통과 확인**

Run: `npm test -- cli` then `npm test` then `npm run typecheck`
Expected: 새 3개 포함 전부 PASS, typecheck 클린.

- [ ] **Step 5: 커밋**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat: fleet discover + adopt CLI commands"
```

---

## Task 4: 패널 "기존 세션 가져오기" UI

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `GET /api/projects/:name/available`, `POST /api/sessions/adopt`.
- Produces: 프로젝트마다 "기존 세션 가져오기" 토글 → 목록 + 각 "가져오기" 버튼. 2초 리렌더에도 펼침상태 유지(모듈 상태).

- [ ] **Step 1: CSS 추가 (`</style>` 앞)**

```css
  .avail { background: #14171b; border-radius: 10px; padding: 6px 10px; margin: 0 0 6px; }
  .a-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-top: 1px solid #23272e; }
  .a-row:first-child { border-top: 0; }
  .a-meta { flex: 1; min-width: 0; }
  .a-snip { font-size: 13px; color: #c7ccd1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .a-sub { font-size: 11px; color: #6b727a; }
  .a-row button { border: 0; border-radius: 8px; background: #1e2f22; color: #7ee2a8; padding: 6px 10px; font-size: 12px; cursor: pointer; }
  .discbtn { background: #1a1f26 !important; color: #8a929b !important; }
  .a-hint { font-size: 11px; color: #6b727a; padding: 4px 0; }
```

- [ ] **Step 2: JS — 모듈 상태 + renderSessions/sessionAction 확장**

`let currentId = null;` 근처에 상태 추가:
```ts
  let expandedProj = null;
  const availCache = {};
```
`renderSessions`의 프로젝트 템플릿(`return \`<div class="proj">…\`)를 아래로 교체 — 기존 rows 뒤에 discover 영역 추가:
```js
      const discover = expandedProj === p.name
        ? `<div class="avail">
             <div class="a-hint">⚠️ 가져올 세션은 다른 곳에서 열려있으면 안 돼요(원 터미널 먼저 닫기).</div>
             ${(availCache[p.name] || []).length
               ? (availCache[p.name]).map((a) =>
                   `<div class="a-row"><div class="a-meta"><div class="a-snip">${esc(a.snippet || a.id)}</div><div class="a-sub">${esc(a.mtime.slice(0,16).replace("T"," "))} · ${esc(a.id.slice(0,8))}</div></div><button data-act="adopt" data-id="${esc(a.id)}" data-proj="${esc(p.name)}">가져오기</button></div>`).join("")
               : `<div class="a-hint">가져올 세션이 없어요.</div>`}
             <div class="srow"><button class="discbtn" data-act="collapse">닫기</button></div>
           </div>`
        : `<div class="srow"><button class="discbtn" data-act="discover" data-proj="${esc(p.name)}">기존 세션 가져오기</button></div>`;
      return `<div class="proj"><h3>${esc(p.name)}</h3>${rows}<div class="srow"><button class="newbtn" data-act="new" data-proj="${esc(p.name)}">+ 새 세션</button></div>${discover}</div>`;
```
`sessionAction(d)`에 분기 추가:
```js
    else if (d.act === "discover") {
      expandedProj = d.proj;
      try { availCache[d.proj] = await fetch(q(`/api/projects/${d.proj}/available`)).then((r) => r.json()); }
      catch (e) { availCache[d.proj] = []; }
    }
    else if (d.act === "collapse") { expandedProj = null; }
    else if (d.act === "adopt") {
      await fetch(q("/api/sessions/adopt"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: d.id, project: d.proj }) });
      expandedProj = null;
    }
```
(기존 new/resume/close/open 분기 뒤에 이어붙이고, 함수 끝의 `pollSessions();` 는 그대로 두어 재렌더.)

- [ ] **Step 3: 수동 확인**

launchd 서비스가 최신 코드로 돌게 하려면 이 태스크는 **머지 후 재시작**에서 최종 검증한다. 여기서는:
- `node --check`로 인라인 스크립트 문법 확인: `awk '/<script>/{f=1;next}/<\/script>/{f=0}f' public/index.html > /tmp/p.js && node --check /tmp/p.js`
- (dev 서버로) `FLEET_PANEL_TOKEN=dev npm start` 백그라운드 → `curl -s 'http://127.0.0.1:4179/?token=dev' | grep -c '기존 세션 가져오기'` ≥1, `grep -c 'data-act="adopt"'`는 펼치기 전이라 0이어도 정상 → 페이지가 에러 없이 서빙되는지 + Phase 1/2 요소 유지 확인. 서버 kill.

Expected: JS 문법 OK, 페이지에 "기존 세션 가져오기" 버튼 있음, 콘솔 에러 없음.

- [ ] **Step 4: 커밋**

```bash
git add public/index.html
git commit -m "feat: panel adopt UI (discover + import existing sessions)"
```

---

## Self-Review 결과
- **커버리지:** discover→Task1(로직)+Task2(엔드포인트)+Task3(CLI)+Task4(패널); adopt 동일. server 배선(claudeProjectsDir)→Task2. 안전 안내(원 터미널 닫기)→Task4 패널 힌트(+CLI는 usage로 충분). 갭 없음.
- **플레이스홀더:** 없음.
- **타입 일관성:** `AvailableSession`(Task1)이 discover 반환·엔드포인트·CLI 렌더에서 동일. `claudeProjectsDir` 옵션이 Task1 정의·Task2 배선·테스트 boot에서 일치. adopt는 `--resume`+기존 id 사용으로 세션 id 불변식 유지.
