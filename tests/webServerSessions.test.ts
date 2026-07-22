import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
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
  const store = new SessionStore(join(dir, "sessions.json"), join(dir, "projects.json"));
  store.addProject("myapp", "/p/myapp");
  const runner = new FakeRunner();
  let seq = 0;
  const sessions = new SessionManager({
    store, runner, repoRoot: "/repo", orchUrl: "http://127.0.0.1:4179",
    mcpDir: join(dir, "mcp"), ruleText: "RULE", claudeProjectsDir: join(dir, "claude-projects"),
    genId: () => `uuid${++seq}0000`,
  });
  const server = createServer({ panelToken: TOKEN, publicDir: join(dir, "public"), sessions });
  return new Promise<{ base: string; dir: string; sessions: SessionManager; close: () => void }>((res) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      res({ base: `http://127.0.0.1:${port}`, dir, sessions, close: () => server.close() });
    });
  });
}
const q = (base: string, p: string) => `${base}${p}${p.includes("?") ? "&" : "?"}token=${TOKEN}`;

test("GET /api/projects returns registered projects (token-guarded)", async () => {
  const { base, close } = await boot();
  expect((await fetch(`${base}/api/projects`)).status).toBe(401);
  const r = await fetch(q(base, "/api/projects"));
  expect(await r.json()).toEqual([{ name: "myapp", path: "/p/myapp" }]);
  close();
});

test("POST /api/sessions launches; 3rd is 409; GET lists them", async () => {
  const { base, close } = await boot();
  const a = await (await fetch(q(base, "/api/sessions"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "myapp" }) })).json();
  expect(a.status).toBe("running");
  await fetch(q(base, "/api/sessions"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "myapp" }) });
  const third = await fetch(q(base, "/api/sessions"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "myapp" }) });
  expect(third.status).toBe(409);
  const list = await (await fetch(q(base, "/api/sessions"))).json();
  expect(list).toHaveLength(2);
  expect(list[0]).toHaveProperty("activity"); // enriched session fields present
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
  const a = await (await fetch(q(base, "/api/sessions"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "myapp" }) })).json();
  const c = await fetch(q(base, `/api/sessions/${a.id}/close`), { method: "POST" });
  expect((await c.json()).status).toBe("stopped");
  const r = await fetch(q(base, `/api/sessions/${a.id}/resume`), { method: "POST" });
  expect((await r.json()).status).toBe("running");
  close();
});

test("GET /api/sessions enriches with activity/terminalOpen/remoteActive/prompt", async () => {
  const { base, close } = await boot();
  const a = await (await fetch(q(base, "/api/sessions"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: "myapp" }) })).json();
  const list = await (await fetch(q(base, "/api/sessions"))).json();
  const s = list.find((x: any) => x.id === a.id);
  expect(s).toBeTruthy();
  for (const k of ["activity", "terminalOpen", "remoteActive", "prompt"]) expect(k in s).toBe(true);
  close();
});

function seedSession(dir: string, projectPath: string, id: string, firstUser: string): void {
  const enc = projectPath.replace(/[/.]/g, "-");
  const d = join(dir, "claude-projects", enc);
  mkdirSync(d, { recursive: true });
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: firstUser } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "ok" } }),
  ].join("\n");
  writeFileSync(join(d, `${id}.jsonl`), lines);
}

test("GET /api/projects/:name/available lists discoverable sessions; adopt registers one", async () => {
  const { base, dir, close } = await boot();
  // myapp project registered at /p/myapp in boot(); seed a claude session there
  seedSession(dir, "/p/myapp", "aaaa1111-2222", "이전에 하던 작업");
  const avail = await (await fetch(q(base, "/api/projects/myapp/available"))).json();
  expect(avail).toHaveLength(1);
  expect(avail[0].id).toBe("aaaa1111-2222");

  const adopted = await fetch(q(base, "/api/sessions/adopt"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "aaaa1111-2222", project: "myapp" }),
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
    body: JSON.stringify({ id: "nope", project: "myapp" }),
  });
  expect(r.status).toBe(404);
  close();
});
