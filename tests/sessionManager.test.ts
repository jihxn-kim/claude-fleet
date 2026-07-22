import { expect, test } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/sessionStore.js";
import { SessionManager, HttpError, type CommandRunner } from "../src/sessionManager.js";

class FakeRunner implements CommandRunner {
  calls: Array<{ cmd: string; args: string[] }> = [];
  listOutput = "";
  paneContent = ""; // returned for `tmux capture-pane`
  failKeys = new Set<string>();
  run(cmd: string, args: string[]): string {
    this.calls.push({ cmd, args });
    const sub = args[0];
    if (this.failKeys.has(sub)) throw new Error(`fake fail ${sub}`);
    if (cmd === "tmux" && sub === "list-sessions") return this.listOutput;
    if (cmd === "tmux" && sub === "capture-pane") return this.paneContent;
    return "";
  }
}

function setup(projects: Record<string, string> = { myapp: "/p/myapp" }) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-mgr-"));
  const store = new SessionStore(join(dir, "sessions.json"), join(dir, "projects.json"), () => "2026-07-21T00:00:00.000Z");
  for (const [n, p] of Object.entries(projects)) store.addProject(n, p);
  const runner = new FakeRunner();
  let seq = 0;
  const mgr = new SessionManager({
    store, runner, repoRoot: "/repo", orchUrl: "http://127.0.0.1:4179",
    mcpDir: join(dir, "mcp"), ruleText: "RULE", claudeProjectsDir: join(dir, "claude-projects"),
    now: () => "2026-07-21T00:00:00.000Z", genId: () => `uuid${++seq}0000`,
  });
  return { store, runner, mgr, dir };
}

test("launch: writes mcp config, runs tmux new-session with claude --session-id, registers running", () => {
  const { store, runner, mgr, dir } = setup();
  const e = mgr.launch("myapp");
  expect(e.status).toBe("running");
  expect(e.project).toBe("myapp");
  expect(e.tmuxName).toBe("fleet__myapp__uuid10"); // slug + first6 of "uuid10000"
  // mcp config written
  const cfgPath = join(dir, "mcp", `${e.id}.json`);
  expect(existsSync(cfgPath)).toBe(true);
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  expect(cfg.mcpServers.fleet.env.FLEET_SESSION_TOKEN).toBe(e.id);
  // tmux call
  const call = runner.calls.find((c) => c.cmd === "tmux" && c.args[0] === "new-session")!;
  expect(call.args).toEqual([
    "new-session", "-d", "-s", "fleet__myapp__uuid10", "-c", "/p/myapp", "-e", "COLORTERM=truecolor",
    "claude", "--session-id", e.id,
    "--permission-mode", "auto",
    "--append-system-prompt", "RULE",
    "--mcp-config", cfgPath,
    "--strict-mcp-config",
    "--allowedTools", "mcp__fleet__request_decision",
  ]);
  expect(store.getSession(e.id)!.status).toBe("running");
});

test("sampleActivity: busy when the status line shows 'esc to interrupt', else idle", () => {
  const { mgr, runner } = setup();
  const e = mgr.launch("myapp"); // running session
  runner.paneContent = "some output\n  auto mode on · esc to interrupt · 5 agents";
  mgr.sampleActivity();
  expect(mgr.sessionActivity()[e.id]).toBe("busy");
  // typing at the idle prompt changes the screen but shows no "esc to interrupt"
  runner.paneContent = "some output\n╭─────╮\n│ > /remo │\n╰─────╯\n  auto mode on (shift+tab to cycle) · 5 agents";
  mgr.sampleActivity();
  expect(mgr.sessionActivity()[e.id]).toBe("idle");
});

test("sampleActivity: busy while waiting on a background subagent (no 'esc to interrupt')", () => {
  const { mgr, runner } = setup();
  const e = mgr.launch("myapp");
  runner.paneContent = [
    "⏺ Agent(Capacity Task 5)",
    "  ⎿ Backgrounded agent (↓ to manage)",
    "✻ Waiting for 1 background agent to finish",
    "❯ ",
    "  auto mode on (shift+tab to cycle) · 5 agents",
  ].join("\n");
  mgr.sampleActivity();
  expect(mgr.sessionActivity()[e.id]).toBe("busy");
});

test("sessionActivity: only running sessions get a value", () => {
  const { mgr } = setup();
  const e = mgr.launch("myapp");
  mgr.close(e.id); // now stopped
  mgr.sampleActivity();
  expect(mgr.sessionActivity()[e.id]).toBeUndefined();
});

test("terminate: kills tmux and removes the session from the store", () => {
  const { mgr, store, runner } = setup();
  const e = mgr.launch("myapp");
  expect(store.getSession(e.id)).toBeDefined();
  mgr.terminate(e.id);
  expect(runner.calls.some((c) => c.cmd === "tmux" && c.args[0] === "kill-session" && c.args.includes(e.tmuxName))).toBe(true);
  expect(store.getSession(e.id)).toBeUndefined();
});

test("connectRemote: types /remote-control + Enter into the session", () => {
  const { mgr, runner } = setup();
  const e = mgr.launch("myapp");
  mgr.connectRemote(e.id);
  const sk = runner.calls.filter((c) => c.cmd === "tmux" && c.args[0] === "send-keys" && c.args.includes(e.tmuxName));
  expect(sk.some((c) => c.args.includes("/remote-control"))).toBe(true);
  expect(sk.some((c) => c.args.includes("Enter"))).toBe(true);
});

test("connectRemote disconnect: navigates the cursor from Continue up to Disconnect, selects it", () => {
  const { mgr, runner } = setup();
  const e = mgr.launch("myapp");
  runner.paneContent = [
    "  Remote Control",
    "    Disconnect this session",
    "    Show QR code  Scan with your phone",
    "  ❯ Continue",
    "  Enter to select · Esc to continue",
  ].join("\n");
  runner.calls.length = 0; // count only the disconnect interaction
  mgr.connectRemote(e.id, true);
  const sk = runner.calls.filter((c) => c.cmd === "tmux" && c.args[0] === "send-keys");
  const ups = sk.filter((c) => c.args.includes("Up"));
  const enters = sk.filter((c) => c.args.includes("Enter"));
  expect(ups.length).toBe(2); // Continue (cursor) → Show QR → Disconnect = 2 up
  expect(enters.length).toBe(2); // run the command, then select
});

test("connectRemote disconnect: 409 when the menu never appears", () => {
  const { mgr, runner } = setup();
  const e = mgr.launch("myapp");
  runner.paneContent = "no menu, no disconnect item here";
  expect(() => mgr.connectRemote(e.id, true)).toThrow(HttpError);
});

const MENU = [
  "무슨 도구를 쓸까?",
  "❯ 1. 첫번째 옵션",
  "  2. 두번째 옵션",
  "  3. 세번째 옵션",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");

test("sampleActivity: mirrors an on-screen selection menu as a prompt", () => {
  const { mgr, runner } = setup();
  const e = mgr.launch("myapp");
  runner.paneContent = MENU;
  mgr.sampleActivity();
  const p = mgr.sessionPrompt(e.id)!;
  expect(p).not.toBeNull();
  expect(p.context).toContain("무슨 도구를 쓸까?");
  expect(p.options).toEqual([
    { n: 1, label: "첫번째 옵션" },
    { n: 2, label: "두번째 옵션" },
    { n: 3, label: "세번째 옵션" },
  ]);
});

test("sampleActivity: yes/no permission prompt — 'Do you want to proceed?' is the question, not the footer", () => {
  const { mgr, runner } = setup();
  const e = mgr.launch("myapp");
  runner.paneContent = [
    " Contains shell syntax (string) that cannot be statically analyzed",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. No",
    "",
    " Esc to cancel · Tab to amend · ctrl+e to explain",
  ].join("\n");
  mgr.sampleActivity();
  const p = mgr.sessionPrompt(e.id)!;
  expect(p).not.toBeNull();
  expect(p.options).toEqual([{ n: 1, label: "Yes" }, { n: 2, label: "No" }]);
  expect(p.context).toContain("Do you want to proceed?");
  expect(p.context).toContain("Contains shell syntax");
});

test("sampleActivity: no menu → no prompt", () => {
  const { mgr, runner } = setup();
  const e = mgr.launch("myapp");
  runner.paneContent = "그냥 대화 중\n  auto mode on · 5 agents";
  mgr.sampleActivity();
  expect(mgr.sessionPrompt(e.id)).toBeNull();
});

test("answerPrompt: navigates from the cursor to the chosen option, then Enter", () => {
  const { mgr, runner } = setup();
  const e = mgr.launch("myapp");
  runner.paneContent = MENU; // cursor (❯) on option 1
  runner.calls.length = 0;
  mgr.answerPrompt(e.id, 3); // 1 → 3 = two Downs then Enter
  const sk = runner.calls.filter((c) => c.cmd === "tmux" && c.args[0] === "send-keys");
  expect(sk.filter((c) => c.args.includes("Down")).length).toBe(2);
  expect(sk.filter((c) => c.args.includes("Up")).length).toBe(0);
  expect(sk.filter((c) => c.args.includes("Enter")).length).toBe(1);
});

test("answerPrompt: no menu on screen → 409", () => {
  const { mgr, runner } = setup();
  const e = mgr.launch("myapp");
  runner.paneContent = "no menu here";
  expect(() => mgr.answerPrompt(e.id, 1)).toThrow(HttpError);
});

test("launch unknown project throws HttpError 400", () => {
  const { mgr } = setup();
  expect(() => mgr.launch("nope")).toThrowError(expect.objectContaining({ status: 400 }));
});

test("launch rejected with 409 when 2 already running", () => {
  const { mgr } = setup();
  mgr.launch("myapp");
  mgr.launch("myapp");
  try {
    mgr.launch("myapp");
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(409);
  }
});

test("close: kills tmux and sets stopped; missing -> 404; kill error swallowed", () => {
  const { store, runner, mgr } = setup();
  const e = mgr.launch("myapp");
  const closed = mgr.close(e.id);
  expect(closed.status).toBe("stopped");
  expect(runner.calls.some((c) => c.args[0] === "kill-session" && c.args.includes(e.tmuxName))).toBe(true);
  expect(() => mgr.close("nope")).toThrowError(expect.objectContaining({ status: 404 }));
  // kill error swallowed
  runner.failKeys.add("kill-session");
  const e2 = mgr.launch("myapp");
  expect(() => mgr.close(e2.id)).not.toThrow();
  expect(store.getSession(e2.id)!.status).toBe("stopped");
});

test("resume: stopped -> new-session with --resume, running; running -> 409", () => {
  const { runner, mgr } = setup();
  const e = mgr.launch("myapp");
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

test("resume rejected with 409 when project already has 2 running", () => {
  const { mgr } = setup();
  const a = mgr.launch("myapp");
  mgr.launch("myapp");   // 2 running
  mgr.close(a.id);        // a stopped; 1 running
  mgr.launch("myapp");   // 2 running again (a still stopped)
  expect(() => mgr.resume(a.id)).toThrowError(expect.objectContaining({ status: 409 }));
});

test("reconcile: running sessions absent from tmux list become stopped", () => {
  const { store, runner, mgr } = setup();
  const a = mgr.launch("myapp");
  const b = mgr.launch("myapp");
  // only a is alive in tmux
  runner.listOutput = `${a.tmuxName}\nother-unrelated\n`;
  mgr.reconcile();
  expect(store.getSession(a.id)!.status).toBe("running");
  expect(store.getSession(b.id)!.status).toBe("stopped");
});

test("reconcile: tmux server down (list-sessions errors) marks all running stopped", () => {
  const { store, runner, mgr } = setup();
  const a = mgr.launch("myapp");
  runner.failKeys.add("list-sessions");
  mgr.reconcile();
  expect(store.getSession(a.id)!.status).toBe("stopped");
});

test("openTerminal runs osascript for the session; missing -> 404", () => {
  const { runner, mgr } = setup();
  const e = mgr.launch("myapp");
  mgr.openTerminal(e.id);
  expect(runner.calls.some((c) => c.cmd === "osascript" && c.args.join(" ").includes(e.tmuxName))).toBe(true);
  expect(() => mgr.openTerminal("nope")).toThrowError(expect.objectContaining({ status: 404 }));
});

import { writeFileSync as _wf, mkdirSync as _mk } from "node:fs";

function seedClaudeSession(claudeDir: string, projectPath: string, id: string, firstUser: string): void {
  const enc = projectPath.replace(/[/.]/g, "-");
  const dir = join(claudeDir, enc);
  _mk(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "mode", mode: "normal", sessionId: id }),
    JSON.stringify({ type: "user", message: { role: "user", content: firstUser } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "ok" } }),
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
  seedClaudeSession(claudeDir, "/p/myapp", "11111111-aaaa", "첫 작업 요청 내용");
  const list = mgr2.discover("myapp");
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
  expect(mgr2.discover("myapp")).toEqual([]); // dir 없음 → 빈 배열
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
  seedClaudeSession(claudeDir, "/p/myapp", "22222222-bbbb", "이전 대화");
  const e = mgr.adopt("22222222-bbbb", "myapp");
  expect(e.id).toBe("22222222-bbbb");
  expect(e.status).toBe("running");
  expect(e.tmuxName).toBe("fleet__myapp__222222");
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
  expect(() => mgr.adopt("no-file", "myapp")).toThrowError(expect.objectContaining({ status: 404 }));
  seedClaudeSession(claudeDir, "/p/myapp", "33333333-cccc", "hi");
  mgr.adopt("33333333-cccc", "myapp"); // running now
  expect(() => mgr.adopt("33333333-cccc", "myapp")).toThrowError(expect.objectContaining({ status: 409 })); // already running
  // fill to 2 running with fresh launches, then adopt a 3rd distinct file → 409 max-2
  seedClaudeSession(claudeDir, "/p/myapp", "44444444-dddd", "hi2");
  mgr.launch("myapp"); // 2 running (33.. + gen1)
  expect(() => mgr.adopt("44444444-dddd", "myapp")).toThrowError(expect.objectContaining({ status: 409 }));
});

test("snippet strips control chars (terminal-injection safe) and reads bounded prefix", () => {
  const { store, dir } = setup();
  const runner = new FakeRunner();
  const claudeDir = join(dir, "claude-projects");
  const mgr = new SessionManager({
    store, runner, repoRoot: "/repo", orchUrl: "http://127.0.0.1:4179",
    mcpDir: join(dir, "mcp"), ruleText: "RULE", claudeProjectsDir: claudeDir,
  });
  seedClaudeSession(claudeDir, "/p/myapp", "55555555-eeee", "hi\x1b[31mred\x1b[0m\tthere");
  const snip = mgr.discover("myapp").find((s) => s.id === "55555555-eeee")!.snippet;
  expect(snip).not.toMatch(/[\x00-\x1f]/);
  expect(snip).toContain("hi");
});

test("snippet = LAST real user message, skipping caveats/system/tool_result turns", () => {
  const { store, dir } = setup();
  const runner = new FakeRunner();
  const claudeDir = join(dir, "claude-projects");
  const mgr = new SessionManager({
    store, runner, repoRoot: "/repo", orchUrl: "http://127.0.0.1:4179",
    mcpDir: join(dir, "mcp"), ruleText: "RULE", claudeProjectsDir: claudeDir,
  });
  const d = join(claudeDir, "/p/myapp".replace(/[/.]/g, "-"));
  _mk(d, { recursive: true });
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: "<local-command-caveat>ignore me" } }),
    JSON.stringify({ type: "user", message: { role: "user", content: "프로젝트 초반 질문" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "..." } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "x" }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: "방화벽 포트 왜 안 막혀?" } }),
  ].join("\n");
  _wf(join(d, "77777777-ffff.jsonl"), lines);
  const snip = mgr.discover("myapp").find((s) => s.id === "77777777-ffff")!.snippet;
  expect(snip).toBe("방화벽 포트 왜 안 막혀?");
});

test("discover hides empty stub sessions (no assistant turn)", () => {
  const { store, dir } = setup();
  const runner = new FakeRunner();
  const claudeDir = join(dir, "claude-projects");
  const mgr = new SessionManager({
    store, runner, repoRoot: "/repo", orchUrl: "http://127.0.0.1:4179",
    mcpDir: join(dir, "mcp"), ruleText: "RULE", claudeProjectsDir: claudeDir,
  });
  const d = join(claudeDir, "/p/myapp".replace(/[/.]/g, "-"));
  _mk(d, { recursive: true });
  _wf(join(d, "aaaaaaaa-stub.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }));
  seedClaudeSession(claudeDir, "/p/myapp", "bbbbbbbb-real", "진짜 대화");
  const ids = mgr.discover("myapp").map((s) => s.id);
  expect(ids).toContain("bbbbbbbb-real");
  expect(ids).not.toContain("aaaaaaaa-stub");
});
