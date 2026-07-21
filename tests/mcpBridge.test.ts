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
