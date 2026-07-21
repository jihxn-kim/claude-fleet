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
