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
