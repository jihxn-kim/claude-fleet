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
