import { expect, test } from "vitest";
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
  expect((list[0] as unknown as Record<string, unknown>).resolve).toBeUndefined();
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

test("abort removes the pending decision and rejects its promise", async () => {
  const { store } = newStore();
  const { id, answer } = store.create("session-1", REQ);
  expect(store.abort(id)).toBe(true);
  await expect(answer).rejects.toThrow(/aborted/);
  expect(store.list()).toHaveLength(0);
  expect(store.abort(id)).toBe(false); // already gone
});

test("list() leaks neither resolve nor reject", () => {
  const { store } = newStore();
  store.create("session-1", REQ);
  const v = store.list()[0] as unknown as Record<string, unknown>;
  expect(v.resolve).toBeUndefined();
  expect(v.reject).toBeUndefined();
});
