# Claude 함대 컨트롤 — Phase 1 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 세션이 `request_decision`으로 결정을 올리면 폰 패널에 카드로 뜨고, 1·2·3/메모로 답하면 그 답이 세션에 리턴되어 이어서 일하는 최소 루프를 완성한다.

**Architecture:** 맥에서 상시 도는 **오케스트레이터(순수 HTTP 서버)** 가 결정 저장소·패널·세션용 롱폴링 엔드포인트를 담당한다. 각 `claude` 세션은 **stdio MCP 브릿지**를 붙여, `request_decision` 호출 시 브릿지가 오케스트레이터에 POST하고 답이 올 때까지 응답을 잡아둔다(롱폴링). 폰은 Tailscale로 패널에 접속한다. MCP HTTP 트랜스포트의 세션관리 복잡도를 피하려고, 오케스트레이터는 평범한 `node:http` 서버로만 두고 MCP는 stdio 브릿지로 분리했다.

**Tech Stack:** Node 24 + TypeScript(ESM, NodeNext), `tsx`(빌드 없이 실행), `vitest`(테스트), `@modelcontextprotocol/sdk` + `zod`(MCP stdio 브릿지), `node:http`(오케스트레이터). tmux(세션 터미널), Tailscale(원격).

## Global Constraints

- Node >= 20 (개발기 v24.12 확인). package.json `"type": "module"`, 상대 import는 `.js` 확장자(NodeNext ESM).
- 빌드 단계 없음 — 실행/테스트 모두 `tsx`/`vitest`가 TS 직접 처리. 세션이 붙는 브릿지도 `node_modules/.bin/tsx`로 실행.
- 기본 포트 `4179` (`FLEET_PORT`로 변경). 오케스트레이터 URL 기본 `http://127.0.0.1:4179`.
- 패널 API는 **패널 토큰** 필수. `?token=` 쿼리 또는 `x-fleet-token` 헤더. 기본값 `change-me-please`는 반드시 교체(부트스트랩에서 안내).
- 세션→오케스트레이터 내부 엔드포인트는 `x-fleet-session` 헤더로 세션 토큰 전달. Phase 1은 단일 세션(`session-1`) 전제, 다중 식별은 Phase 2.
- 카드 섹션 한글 카피 고정: `지금 왜?`, `THE PAYOFF`, `트레이드오프`, `알아두면 좋은 맥락`. 입력 안내: `번호를 누르거나 메모로 답하세요`.
- 프로젝트 루트: `~/Desktop/claude-fleet`. 히스토리·데이터는 `data/`(gitignore됨).
- DRY / YAGNI / TDD / 잦은 커밋.

---

## 파일 구조

```
claude-fleet/
  package.json              # type:module, deps, scripts (Task 1)
  tsconfig.json             # NodeNext, strict (Task 1)
  vitest.config.ts          # (Task 1)
  src/
    config.ts               # 포트/토큰/데이터경로 (Task 1)
    types.ts                # DecisionRequest/Answer/View 타입 (Task 2)
    decisionStore.ts        # 인메모리 pending + JSONL 히스토리 (Task 2)
    webServer.ts            # createServer(store,opts): node:http 라우팅 (Task 3)
    server.ts               # 엔트리: config+store+webServer 기동 (Task 3)
    mcpBridge.ts            # stdio MCP 서버 + forwardDecision() (Task 4)
  public/
    index.html              # 최소 패널: 카드+1/2/3+메모+폴링 (Task 5)
  scripts/
    seed-decision.ts        # 가짜 결정 넣어 UI 수동확인 (Task 5)
  tests/
    decisionStore.test.ts   # (Task 2)
    webServer.test.ts       # (Task 3)
    mcpBridge.test.ts       # (Task 4)
  docs/
    BOOTSTRAP.md            # tmux+claude 실행, Tailscale, E2E (Task 6)
  fleet-rule.txt            # 세션에 주입할 함대 규칙 (Task 6)
```

---

## Task 1: 프로젝트 스캐폴드 + 설정

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/config.ts`, `tests/smoke.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `CONFIG: { port: number; panelToken: string; dataDir: string; historyPath: string }` (from `src/config.ts`)

- [ ] **Step 1: package.json 작성**

```json
{
  "name": "claude-fleet",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "start": "tsx src/server.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: tsconfig.json 작성**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "tests", "scripts"]
}
```

- [ ] **Step 3: vitest.config.ts 작성**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: src/config.ts 작성**

```ts
import { join } from "node:path";

const dataDir = process.env.FLEET_DATA_DIR ?? join(process.cwd(), "data");

export const CONFIG = {
  port: Number(process.env.FLEET_PORT ?? 4179),
  panelToken: process.env.FLEET_PANEL_TOKEN ?? "change-me-please",
  dataDir,
  historyPath: join(dataDir, "decisions.jsonl"),
};
```

- [ ] **Step 5: 스모크 테스트 작성 (tests/smoke.test.ts)**

```ts
import { expect, test } from "vitest";
import { CONFIG } from "../src/config.js";

test("config has defaults", () => {
  expect(CONFIG.port).toBe(4179);
  expect(CONFIG.historyPath).toContain("decisions.jsonl");
});
```

- [ ] **Step 6: 설치 + 테스트 실행**

Run:
```bash
cd ~/Desktop/claude-fleet && npm install && npm test
```
Expected: 1개 테스트 PASS.

- [ ] **Step 7: 커밋**

```bash
git add package.json tsconfig.json vitest.config.ts src/config.ts tests/smoke.test.ts package-lock.json
git commit -m "chore: scaffold node+ts project with config"
```

---

## Task 2: DecisionStore (인메모리 pending + 히스토리)

**Files:**
- Create: `src/types.ts`, `src/decisionStore.ts`, `tests/decisionStore.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `DecisionOption { n: number; label: string; action_preview?: string }`
  - `DecisionRequest { title, why_now, payoff, tradeoff, context?, options: DecisionOption[], allow_freetext: boolean }`
  - `DecisionAnswer { choice?: number; memo?: string }`
  - `PendingDecisionView { id: string; sessionToken: string; request: DecisionRequest; createdAt: string }`
  - `class DecisionStore(historyPath: string, now?: () => string)` with:
    - `create(sessionToken: string, request: DecisionRequest): { id: string; answer: Promise<DecisionAnswer> }`
    - `list(): PendingDecisionView[]`
    - `answer(id: string, ans: DecisionAnswer): boolean`

- [ ] **Step 1: 타입 작성 (src/types.ts)**

```ts
export interface DecisionOption {
  n: number;
  label: string;
  action_preview?: string;
}

export interface DecisionRequest {
  title: string;
  why_now: string;
  payoff: string;
  tradeoff: string;
  context?: string;
  options: DecisionOption[];
  allow_freetext: boolean;
}

export interface DecisionAnswer {
  choice?: number;
  memo?: string;
}

export interface PendingDecisionView {
  id: string;
  sessionToken: string;
  request: DecisionRequest;
  createdAt: string;
}
```

- [ ] **Step 2: 실패하는 테스트 작성 (tests/decisionStore.test.ts)**

```ts
import { expect, test, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DecisionStore } from "../src/decisionStore.js";
import type { DecisionRequest } from "../src/types.js";

const REQ: DecisionRequest = {
  title: "t", why_now: "w", payoff: "p", tradeoff: "tr",
  options: [{ n: 1, label: "a" }, { n: 2, label: "b" }],
  allow_freetext: true,
};

function newStore() {
  const dir = mkdtempSync(join(tmpdir(), "fleet-"));
  return { store: new DecisionStore(join(dir, "h.jsonl"), () => "2026-07-21T00:00:00.000Z"), dir };
}

test("create then list shows the pending decision without resolve()", () => {
  const { store } = newStore();
  const { id } = store.create("session-1", REQ);
  const list = store.list();
  expect(list).toHaveLength(1);
  expect(list[0].id).toBe(id);
  expect(list[0].sessionToken).toBe("session-1");
  expect((list[0] as Record<string, unknown>).resolve).toBeUndefined();
});

test("answer resolves the pending promise and removes it from list", async () => {
  const { store } = newStore();
  const { id, answer } = store.create("session-1", REQ);
  const ok = store.answer(id, { choice: 1, memo: "go" });
  expect(ok).toBe(true);
  await expect(answer).resolves.toEqual({ choice: 1, memo: "go" });
  expect(store.list()).toHaveLength(0);
});

test("answer with unknown id returns false", () => {
  const { store } = newStore();
  expect(store.answer("nope", { choice: 1 })).toBe(false);
});

test("answer appends a history line", () => {
  const { store, dir } = newStore();
  const { id } = store.create("session-1", REQ);
  store.answer(id, { choice: 2 });
  const path = join(dir, "h.jsonl");
  expect(existsSync(path)).toBe(true);
  const line = JSON.parse(readFileSync(path, "utf8").trim());
  expect(line.id).toBe(id);
  expect(line.answer).toEqual({ choice: 2 });
  expect(line.answeredAt).toBe("2026-07-21T00:00:00.000Z");
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npm test -- decisionStore`
Expected: FAIL — `Cannot find module '../src/decisionStore.js'`.

- [ ] **Step 4: DecisionStore 구현 (src/decisionStore.ts)**

```ts
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DecisionRequest, DecisionAnswer, PendingDecisionView } from "./types.js";

interface Pending {
  id: string;
  sessionToken: string;
  request: DecisionRequest;
  createdAt: string;
  resolve: (a: DecisionAnswer) => void;
}

export class DecisionStore {
  private pending = new Map<string, Pending>();
  private seq = 0;

  constructor(
    private historyPath: string,
    private now: () => string = () => new Date().toISOString(),
  ) {}

  create(sessionToken: string, request: DecisionRequest): { id: string; answer: Promise<DecisionAnswer> } {
    const id = `d${++this.seq}`;
    let resolve!: (a: DecisionAnswer) => void;
    const answer = new Promise<DecisionAnswer>((r) => (resolve = r));
    this.pending.set(id, { id, sessionToken, request, createdAt: this.now(), resolve });
    return { id, answer };
  }

  list(): PendingDecisionView[] {
    return [...this.pending.values()].map(({ resolve: _resolve, ...view }) => view);
  }

  answer(id: string, ans: DecisionAnswer): boolean {
    const pd = this.pending.get(id);
    if (!pd) return false;
    this.pending.delete(id);
    this.appendHistory(pd, ans);
    pd.resolve(ans);
    return true;
  }

  private appendHistory(pd: Pending, ans: DecisionAnswer): void {
    const line = JSON.stringify({
      id: pd.id,
      sessionToken: pd.sessionToken,
      request: pd.request,
      answer: ans,
      createdAt: pd.createdAt,
      answeredAt: this.now(),
    });
    mkdirSync(dirname(this.historyPath), { recursive: true });
    appendFileSync(this.historyPath, line + "\n");
  }
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npm test -- decisionStore`
Expected: 4개 PASS.

- [ ] **Step 6: 커밋**

```bash
git add src/types.ts src/decisionStore.ts tests/decisionStore.test.ts
git commit -m "feat: DecisionStore with pending map and jsonl history"
```

---

## Task 3: 오케스트레이터 HTTP 서버

**Files:**
- Create: `src/webServer.ts`, `src/server.ts`, `tests/webServer.test.ts`

**Interfaces:**
- Consumes: `DecisionStore` (Task 2), `CONFIG` (Task 1)
- Produces:
  - `createServer(store: DecisionStore, opts: { panelToken: string; publicDir: string }): http.Server`
  - HTTP 계약:
    - `POST /internal/decisions` — 헤더 `x-fleet-session`, body = `DecisionRequest` JSON. 응답을 **답이 올 때까지 보류**했다가 `DecisionAnswer` JSON 200 반환.
    - `GET /api/decisions` — 토큰 필요. `PendingDecisionView[]` 반환.
    - `POST /api/decisions/:id/answer` — 토큰 필요. body = `DecisionAnswer`. 성공 `{ok:true}` 200, 없는 id `{ok:false}` 404.
    - `GET /` , `GET /index.html` — `publicDir`의 정적 파일(토큰 불필요).

- [ ] **Step 1: 실패하는 테스트 작성 (tests/webServer.test.ts)**

```ts
import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { DecisionStore } from "../src/decisionStore.js";
import { createServer } from "../src/webServer.js";
import type { DecisionRequest } from "../src/types.js";

const REQ: DecisionRequest = {
  title: "t", why_now: "w", payoff: "p", tradeoff: "tr",
  options: [{ n: 1, label: "a" }], allow_freetext: true,
};
const TOKEN = "secret";

function boot() {
  const dir = mkdtempSync(join(tmpdir(), "fleet-web-"));
  const store = new DecisionStore(join(dir, "h.jsonl"));
  const server = createServer(store, { panelToken: TOKEN, publicDir: join(dir, "public") });
  return new Promise<{ base: string; store: DecisionStore; close: () => void }>((res) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      res({ base: `http://127.0.0.1:${port}`, store, close: () => server.close() });
    });
  });
}

test("GET /api/decisions without token is 401", async () => {
  const { base, close } = await boot();
  const r = await fetch(`${base}/api/decisions`);
  expect(r.status).toBe(401);
  close();
});

test("GET /api/decisions with token returns empty list", async () => {
  const { base, close } = await boot();
  const r = await fetch(`${base}/api/decisions?token=${TOKEN}`);
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual([]);
  close();
});

test("full loop: internal POST blocks, panel sees it, answer resolves it", async () => {
  const { base, close } = await boot();

  // 세션 역할: 결정 등록 (응답이 보류됨 → await 하지 않고 붙잡아둔다)
  const sessionCall = fetch(`${base}/internal/decisions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fleet-session": "session-1" },
    body: JSON.stringify(REQ),
  });

  // 패널에 뜰 때까지 잠깐 폴링
  let pending: Array<{ id: string }> = [];
  for (let i = 0; i < 50 && pending.length === 0; i++) {
    pending = await (await fetch(`${base}/api/decisions?token=${TOKEN}`)).json();
    if (pending.length === 0) await new Promise((r) => setTimeout(r, 10));
  }
  expect(pending).toHaveLength(1);
  const id = pending[0].id;

  // 패널 역할: 답
  const ans = await fetch(`${base}/api/decisions/${id}/answer?token=${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ choice: 1, memo: "go" }),
  });
  expect(ans.status).toBe(200);
  expect(await ans.json()).toEqual({ ok: true });

  // 세션의 보류됐던 응답이 답으로 풀림
  const resolved = await (await sessionCall).json();
  expect(resolved).toEqual({ choice: 1, memo: "go" });
  close();
});

test("answering unknown id is 404", async () => {
  const { base, close } = await boot();
  const r = await fetch(`${base}/api/decisions/nope/answer?token=${TOKEN}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  expect(r.status).toBe(404);
  close();
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test -- webServer`
Expected: FAIL — `Cannot find module '../src/webServer.js'`.

- [ ] **Step 3: webServer 구현 (src/webServer.ts)**

```ts
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
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- webServer`
Expected: 4개 PASS. (정적 404는 public 폴더가 없어도 통과 — /api·/internal만 검증)

- [ ] **Step 5: 엔트리 작성 (src/server.ts)**

```ts
import { join } from "node:path";
import { DecisionStore } from "./decisionStore.js";
import { createServer } from "./webServer.js";
import { CONFIG } from "./config.js";

const store = new DecisionStore(CONFIG.historyPath);
const publicDir = join(process.cwd(), "public");
const server = createServer(store, { panelToken: CONFIG.panelToken, publicDir });

server.listen(CONFIG.port, () => {
  console.log(`fleet orchestrator on http://127.0.0.1:${CONFIG.port}`);
  console.log(`panel: http://127.0.0.1:${CONFIG.port}/?token=${CONFIG.panelToken}`);
  if (CONFIG.panelToken === "change-me-please") {
    console.warn("⚠️  FLEET_PANEL_TOKEN 기본값 사용 중 — 실제 토큰으로 교체하세요.");
  }
});
```

- [ ] **Step 6: 수동 기동 확인**

Run: `FLEET_PANEL_TOKEN=dev npm start`
Expected: `fleet orchestrator on http://127.0.0.1:4179` 출력. `Ctrl+C`로 종료.

- [ ] **Step 7: 커밋**

```bash
git add src/webServer.ts src/server.ts tests/webServer.test.ts
git commit -m "feat: orchestrator http server with long-poll and panel api"
```

---

## Task 4: stdio MCP 브릿지

**Files:**
- Create: `src/mcpBridge.ts`, `tests/mcpBridge.test.ts`

**Interfaces:**
- Consumes: 오케스트레이터 `POST /internal/decisions` 계약(Task 3), `DecisionRequest`/`DecisionAnswer`(Task 2)
- Produces:
  - `forwardDecision(orchUrl: string, token: string, args: DecisionRequest): Promise<DecisionAnswer>`
  - 실행 시 stdio MCP 서버로 동작하며 `request_decision` 툴을 노출(툴 핸들러가 `forwardDecision` 호출).

- [ ] **Step 1: 실패하는 테스트 작성 (tests/mcpBridge.test.ts)**

```ts
import { expect, test } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { forwardDecision } from "../src/mcpBridge.js";
import type { DecisionRequest } from "../src/types.js";

const REQ: DecisionRequest = {
  title: "t", why_now: "w", payoff: "p", tradeoff: "tr",
  options: [{ n: 1, label: "a" }], allow_freetext: true,
};

function mockOrch(handler: (body: string) => { status: number; json: unknown }) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const { status, json } = handler(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(json));
  });
  return new Promise<{ base: string; close: () => void }>((r) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      r({ base: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

test("forwardDecision posts request and returns the answer", async () => {
  let seenSession = "";
  let seenBody = "";
  const { base, close } = await mockOrch((body) => {
    seenBody = body;
    return { status: 200, json: { choice: 1, memo: "go" } };
  });
  // 세션 헤더 확인용으로 handler를 못 보므로 body만 검증 + 반환값 검증
  const ans = await forwardDecision(base, "session-1", REQ);
  expect(ans).toEqual({ choice: 1, memo: "go" });
  expect(JSON.parse(seenBody).title).toBe("t");
  close();
  void seenSession;
});

test("forwardDecision throws on non-200", async () => {
  const { base, close } = await mockOrch(() => ({ status: 500, json: { error: "x" } }));
  await expect(forwardDecision(base, "session-1", REQ)).rejects.toThrow(/500/);
  close();
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test -- mcpBridge`
Expected: FAIL — `Cannot find module '../src/mcpBridge.js'`.

- [ ] **Step 3: 브릿지 구현 (src/mcpBridge.ts)**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { DecisionRequest, DecisionAnswer } from "./types.js";

export async function forwardDecision(
  orchUrl: string,
  token: string,
  args: DecisionRequest,
): Promise<DecisionAnswer> {
  const res = await fetch(`${orchUrl}/internal/decisions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fleet-session": token },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`fleet orchestrator returned ${res.status}`);
  return (await res.json()) as DecisionAnswer;
}

const inputShape = {
  title: z.string().describe("상황/질문 한 줄"),
  why_now: z.string().describe("지금 왜 결정이 필요한가"),
  payoff: z.string().describe("이걸 정하면 뭐가 달라지나 (예: A 🔒 vs B 🔥)"),
  tradeoff: z.string().describe("선택지 간 트레이드오프"),
  context: z.string().optional().describe("알아두면 좋은 배경(선택)"),
  options: z
    .array(
      z.object({
        n: z.number().describe("버튼 번호(1,2,3...)"),
        label: z.string().describe("옵션 라벨"),
        action_preview: z.string().optional().describe("이 옵션 고르면 뭐가 되는지 한 줄"),
      }),
    )
    .describe("객관식 옵션들"),
  allow_freetext: z.boolean().describe("메모 자유입력 허용 여부"),
};

export function buildBridge(orchUrl: string, token: string): McpServer {
  const mcp = new McpServer({ name: "fleet", version: "0.1.0" });
  mcp.registerTool(
    "request_decision",
    {
      title: "보스에게 결정 요청",
      description:
        "되돌리기 힘든/외부영향/제품 갈림길에서 멈추지 말고 이 툴로 맥락을 채워 올린다. " +
        "보스가 폰 패널에서 번호/메모로 답할 때까지 블로킹되며, 답이 리턴된다.",
      inputSchema: inputShape,
    },
    async (args) => {
      const answer = await forwardDecision(orchUrl, token, args as DecisionRequest);
      return { content: [{ type: "text", text: JSON.stringify(answer) }] };
    },
  );
  return mcp;
}

// 엔트리로 직접 실행될 때만 stdio 연결
if (process.argv[1] && process.argv[1].endsWith("mcpBridge.ts")) {
  const orchUrl = process.env.FLEET_URL ?? "http://127.0.0.1:4179";
  const token = process.env.FLEET_SESSION_TOKEN ?? "session-1";
  const mcp = buildBridge(orchUrl, token);
  await mcp.connect(new StdioServerTransport());
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- mcpBridge`
Expected: 2개 PASS.

- [ ] **Step 5: 브릿지 stdio 기동 스모크 (수동)**

Run:
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | ./node_modules/.bin/tsx src/mcpBridge.ts
```
Expected: `request_decision` 툴이 포함된 JSON-RPC 응답 1줄 출력(그 후 stdin 대기 → `Ctrl+C`). 툴 목록이 나오면 stdio MCP 등록 OK.

- [ ] **Step 6: 커밋**

```bash
git add src/mcpBridge.ts tests/mcpBridge.test.ts
git commit -m "feat: stdio mcp bridge exposing request_decision"
```

---

## Task 5: 최소 패널 + 시드 스크립트

**Files:**
- Create: `public/index.html`, `scripts/seed-decision.ts`

**Interfaces:**
- Consumes: `GET /api/decisions?token=`, `POST /api/decisions/:id/answer?token=` (Task 3)
- Produces: 폰 브라우저용 단일 페이지. 첫 pending 결정을 카드로 렌더, 1·2·3/메모로 답 전송.

- [ ] **Step 1: 패널 작성 (public/index.html)**

```html
<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>함대 컨트롤</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0d10; color: #e8eaed; font: 16px/1.5 -apple-system, system-ui, sans-serif; padding: 16px; }
  .empty { opacity: .5; text-align: center; margin-top: 40vh; }
  .card { background: #16191d; border-radius: 16px; padding: 20px; max-width: 620px; margin: 0 auto; }
  .title { font-size: 20px; font-weight: 700; margin: 0 0 16px; }
  .sec-label { font-size: 12px; letter-spacing: .08em; color: #8a929b; margin: 16px 0 4px; text-transform: uppercase; }
  .sec { margin: 0; }
  .payoff { background: #1e2228; border-radius: 10px; padding: 12px; font-weight: 600; }
  .opts { display: flex; gap: 10px; margin: 20px 0 8px; }
  .opt { flex: 1; border: 0; border-radius: 12px; background: #23272e; color: #e8eaed; font-size: 22px; font-weight: 700; padding: 20px 0; cursor: pointer; }
  .opt:active { transform: scale(.97); }
  .opt .lab { display: block; font-size: 12px; font-weight: 500; opacity: .7; margin-top: 6px; }
  textarea { width: 100%; background: #1e2228; border: 1px solid #2b3038; border-radius: 12px; color: #e8eaed; padding: 12px; font: inherit; min-height: 64px; }
  .send { margin-top: 10px; width: 100%; border: 0; border-radius: 12px; background: #d2603a; color: #fff; font-size: 16px; font-weight: 700; padding: 14px; cursor: pointer; }
</style>
</head>
<body>
<div id="root"><div class="empty">대기 중인 결정이 없어요</div></div>
<script>
  const token = new URLSearchParams(location.search).get("token") || "";
  const q = (s) => `${s}${s.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
  let currentId = null;

  async function poll() {
    try {
      const list = await (await fetch(q("/api/decisions"))).json();
      render(list[0] || null);
    } catch (e) { /* 네트워크 끊김은 다음 폴에서 복구 */ }
    setTimeout(poll, 1500);
  }

  function esc(s) { return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

  function render(item) {
    const root = document.getElementById("root");
    if (!item) { currentId = null; root.innerHTML = '<div class="empty">대기 중인 결정이 없어요</div>'; return; }
    if (item.id === currentId) return; // 렌더 중 입력 유지
    currentId = item.id;
    const r = item.request;
    const opts = r.options.map((o) =>
      `<button class="opt" data-n="${o.n}">${o.n}<span class="lab">${esc(o.label)}</span></button>`).join("");
    root.innerHTML = `
      <div class="card">
        <p class="title">${esc(r.title)}</p>
        <div class="sec-label">지금 왜?</div><p class="sec">${esc(r.why_now)}</p>
        <div class="sec-label">THE PAYOFF</div><p class="sec payoff">${esc(r.payoff)}</p>
        <div class="sec-label">트레이드오프</div><p class="sec">${esc(r.tradeoff)}</p>
        ${r.context ? `<div class="sec-label">알아두면 좋은 맥락</div><p class="sec">${esc(r.context)}</p>` : ""}
        <div class="opts">${opts}</div>
        ${r.allow_freetext ? '<textarea id="memo" placeholder="예: 2번으로 가자. 대신 배포 전 한 번 더 확인해줘."></textarea><button class="send" id="send">메모로 답하기</button>' : ""}
      </div>`;
    root.querySelectorAll(".opt").forEach((b) =>
      b.addEventListener("click", () => answer({ choice: Number(b.dataset.n) })));
    const send = document.getElementById("send");
    if (send) send.addEventListener("click", () => {
      const memo = document.getElementById("memo").value.trim();
      answer({ memo });
    });
  }

  async function answer(body) {
    if (!currentId) return;
    await fetch(q(`/api/decisions/${currentId}/answer`), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    currentId = null;
    document.getElementById("root").innerHTML = '<div class="empty">보냈어요 ✓</div>';
  }

  poll();
</script>
</body>
</html>
```

- [ ] **Step 2: 시드 스크립트 작성 (scripts/seed-decision.ts)**

```ts
// 가짜 결정 1건을 오케스트레이터에 넣고, 답이 올 때까지 대기 후 출력.
// 실제 claude 세션 없이 패널 UI를 수동 확인하는 용도.
import type { DecisionRequest, DecisionAnswer } from "../src/types.js";

const orchUrl = process.env.FLEET_URL ?? "http://127.0.0.1:4179";
const req: DecisionRequest = {
  title: "완주 API가 인증 없이 열려 있음 — 이메일 선물 켜기 전 서명검증 넣을지",
  why_now: "이메일을 켜는 순간 '가짜 완주 → 진짜 선물 발송' 통로가 될 수 있음. 그 전에 조일지 결정 필요.",
  payoff: "이메일 켜기 전에 문 잠그기 🔒 vs 나중에 악용 발견하고 급하게 막기 🔥",
  tradeoff: "서명검증 추가는 반나절 엔지니어링 / 미루면 노출이 계속됨.",
  context: "누가 API를 직접 호출해 임의 사용자를 '완주'로 표시할 수 있는 pre-existing 취약점.",
  options: [
    { n: 1, label: "지금 서명검증 넣고 켜기", action_preview: "🔒 가짜 완주로 선물 빼가는 길 원천 차단" },
    { n: 2, label: "이메일 먼저 켜고 다음에", action_preview: "🔥 노출 감수하고 속도 우선" },
    { n: 3, label: "완주 API를 인증 뒤로", action_preview: "🔒 근본 차단(범위 큼)" },
  ],
  allow_freetext: true,
};

console.log("결정 넣는 중... 패널에서 답하면 여기 결과가 뜹니다.");
const res = await fetch(`${orchUrl}/internal/decisions`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-fleet-session": "seed" },
  body: JSON.stringify(req),
});
const answer = (await res.json()) as DecisionAnswer;
console.log("받은 답:", answer);
```

- [ ] **Step 3: 수동 UI 확인**

터미널 A: `FLEET_PANEL_TOKEN=dev npm start`
터미널 B: `./node_modules/.bin/tsx scripts/seed-decision.ts`
브라우저: `http://127.0.0.1:4179/?token=dev`
Expected: 카드가 제목·지금왜·THE PAYOFF·트레이드오프·맥락 + 1·2·3 버튼 + 메모로 보임. 버튼을 누르면 브라우저는 "보냈어요 ✓", 터미널 B에 `받은 답: { choice: 1 }` 출력. 메모로 답하면 `{ memo: "..." }` 출력.

- [ ] **Step 4: 커밋**

```bash
git add public/index.html scripts/seed-decision.ts
git commit -m "feat: minimal phone panel and seed script for manual test"
```

---

## Task 6: 세션 부트스트랩 + Tailscale + E2E

**Files:**
- Create: `fleet-rule.txt`, `docs/BOOTSTRAP.md`

**Interfaces:**
- Consumes: 전체 시스템(Task 1~5)
- Produces: 실제 `claude` 세션을 함대에 붙여 폰으로 결정하는 실행 문서 + 주입 규칙.

- [ ] **Step 1: 함대 규칙 작성 (fleet-rule.txt)**

```text
너는 자율 함대 모드로 일한다. 사용자가 붙어있지 않다는 전제로 계속 진행하라.

- 편집/일상 작업은 스스로 판단해 진행한다(자잘한 확인으로 멈추지 말 것).
- 다음에 해당하면 멈추지 말고 반드시 request_decision 툴을 호출해 보스에게 올린다:
  · 되돌리기 어렵거나 외부에 영향을 주는 행동(배포, 삭제, 외부 전송, 과금, 공개)
  · 제품/우선순위/방향이 갈리는 선택
  · 비용·보안·데이터에 중대한 트레이드오프가 있는 선택
- request_decision에는 title, why_now(지금 왜), payoff(정하면 뭐가 달라지나),
  tradeoff, options(1·2·3 + 각 action_preview)를 '보스가 이 카드만 보고 결정할 수 있을 만큼' 채운다.
- 툴은 보스의 답(choice/memo)이 올 때까지 블로킹된다. 답을 받으면 그대로 반영해 이어서 일한다.
- 애매해서 못 고르겠으면 진행을 멈추고 request_decision으로 물어라. 임의로 위험한 선택을 하지 말 것.
```

- [ ] **Step 2: 부트스트랩 문서 작성 (docs/BOOTSTRAP.md)**

````markdown
# 함대 세션 띄우기 (Phase 1)

## 0. 사전 설치 (최초 1회)
```bash
brew install tmux            # 세션 터미널
brew install --cask tailscale  # 또는 App Store 'Tailscale' 설치
```
- 맥과 폰 모두 Tailscale 앱 로그인(같은 계정 = 같은 tailnet).
- 맥의 tailnet 이름 확인: `tailscale status`(맨 위 줄이 이 맥). 예: `my-mac.tailXXXX.ts.net`.

## 1. 오케스트레이터 실행 (상시)
```bash
cd ~/Desktop/claude-fleet
FLEET_PANEL_TOKEN='원하는-긴-토큰' npm start
```
- 로컬 패널: `http://127.0.0.1:4179/?token=원하는-긴-토큰`
- 폰 패널(집 밖 포함): `http://<맥 tailnet 이름>:4179/?token=원하는-긴-토큰`

## 2. 세션에 함대 MCP 붙이기 (프로젝트별 1회)
대상 프로젝트 폴더에서:
```bash
claude mcp add fleet \
  --env FLEET_URL=http://127.0.0.1:4179 \
  --env FLEET_SESSION_TOKEN=session-1 \
  -- /Users/kimjihun/Desktop/claude-fleet/node_modules/.bin/tsx \
     /Users/kimjihun/Desktop/claude-fleet/src/mcpBridge.ts
```

## 3. auto 모드로 세션 시작 (tmux 안)
```bash
tmux new -s proj1
claude --permission-mode acceptEdits \
  --append-system-prompt "$(cat /Users/kimjihun/Desktop/claude-fleet/fleet-rule.txt)"
```
- `tmux attach -t proj1` 로 다시 붙고, `Ctrl-b d` 로 떼어놓는다(세션은 계속 삶).

## 4. E2E 확인
세션 프롬프트에 예: "지금 상황에서 결정이 필요하면 request_decision으로 물어봐" 같은
결정 유발 작업을 준다 → 폰 패널에 카드가 뜨는지 → 번호/메모로 답 → 세션이 이어지는지 확인.
````

- [ ] **Step 3: E2E 수동 검증 (실제 claude 세션)**

1. 오케스트레이터 실행(Step 1의 명령).
2. 임시 프로젝트에서 Step 2·3 수행.
3. 세션에 `request_decision`을 부르도록 지시(예: "배포할지 말지 request_decision으로 물어봐").
4. 로컬 브라우저 + 폰(Tailscale) 둘 다에서 카드 확인.
5. 번호 탭 → 세션 툴콜이 리턴되고 세션이 이어지는지 확인.
6. `data/decisions.jsonl` 에 기록 확인: `tail -1 data/decisions.jsonl | jq`.

Expected: 폰에서 답한 값이 세션에 들어가 대화가 이어지고, jsonl 마지막 줄에 질문+답이 있음.

- [ ] **Step 4: 커밋**

```bash
git add fleet-rule.txt docs/BOOTSTRAP.md
git commit -m "docs: session bootstrap, fleet rule, tailscale and e2e steps"
```

---

## Self-Review 결과

- **스펙 커버리지:** §5.1 오케스트레이터→Task3, §5.2 결정브릿지/§6 스키마→Task4, §5.3 패널→Task5, §5.4 부트스트랩/auto모드→Task6, §9 저장(jsonl)→Task2, §8 Tailscale→Task6, §11 테스트→각 Task의 TDD, §12 수용기준→Task5/6 E2E. **§5.5 Notification 안전망은 Phase 1 범위에서 제외**(스펙에도 "최소 표시만", 놓침방지용) → Phase 2로 명시 이관. 그 외 갭 없음.
- **플레이스홀더:** 없음(모든 코드/명령 실체 포함).
- **타입 일관성:** `DecisionRequest/DecisionAnswer/PendingDecisionView`, `create/list/answer`, `forwardDecision`, `createServer` 시그니처가 Task 간 동일하게 사용됨. `/internal/decisions`·`/api/decisions`·`/api/decisions/:id/answer` 계약이 Task3 정의와 Task4·5 사용에서 일치.

## Phase 1 이후 (참고)
- Phase 2: 오케스트레이터 세션 런처(tmux new/kill/attach), `claude --resume <id>`, 프로젝트당 최대2 강제, 세션 레지스트리·목록 UI, 생사 동기화, 다중 세션 토큰 식별, Notification 안전망.
- Phase 3: 카드 풀스타일, 음성입력(Web Speech API), 파일첨부, 자동저장, 히스토리 UI.
