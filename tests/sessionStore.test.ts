import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
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

test("corrupt json file reads as empty instead of throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-corrupt-"));
  const ss = join(dir, "sessions.json");
  writeFileSync(ss, "{ this is not valid json", "utf8");
  const s = new SessionStore(ss, join(dir, "projects.json"));
  expect(s.listSessions()).toEqual([]);
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
