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

test("session disconnect drops the pending decision and server stays up", async () => {
  const { base, close } = await boot();
  const ctrl = new AbortController();
  const inflight = fetch(`${base}/internal/decisions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fleet-session": "s" },
    body: JSON.stringify(REQ),
    signal: ctrl.signal,
  }).catch(() => "aborted");

  // wait until the decision is queued
  let pending: Array<{ id: string }> = [];
  for (let i = 0; i < 50 && pending.length === 0; i++) {
    pending = await (await fetch(`${base}/api/decisions?token=${TOKEN}`)).json();
    if (pending.length === 0) await new Promise((r) => setTimeout(r, 10));
  }
  expect(pending).toHaveLength(1);

  // session disconnects before answering
  ctrl.abort();
  await inflight;

  // the pending decision drains
  let after: Array<{ id: string }> = [{ id: "x" }];
  for (let i = 0; i < 50 && after.length > 0; i++) {
    after = await (await fetch(`${base}/api/decisions?token=${TOKEN}`)).json();
    if (after.length > 0) await new Promise((r) => setTimeout(r, 10));
  }
  expect(after).toHaveLength(0);

  // server is still alive
  const r = await fetch(`${base}/api/decisions?token=${TOKEN}`);
  expect(r.status).toBe(200);
  close();
});
