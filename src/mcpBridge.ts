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
