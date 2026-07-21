// 가짜 결정 1건을 오케스트레이터에 넣고, 답이 올 때까지 대기 후 출력.
// 실제 claude 세션 없이 패널 UI를 수동 확인하는 용도.
import type { DecisionRequest, DecisionAnswer } from "../src/types.js";

const orchUrl = process.env.FLEET_URL ?? "http://127.0.0.1:4179";
const req: DecisionRequest = {
  title: "완주 API가 인증 없이 열려 있음 — 이메일 선물 켜기 전 서명검증 넣을지",
  why_now: "이메일을 켜는 순간 '가짜 완주 → 진짜 선물 발송' 통로가 될 수 있음. 그 전에 조일지 결정 필요.",
  payoff: "이메일 켜기 전에 문 잠그기 🔒 vs 나중에 악용 발견하고 급하게 막기 🔥",
  tradeoff: "서명검증 추가는 반나절 엔지니어링 / 미루면 노출이 계속됨.",
  context: "누가 API를 직접 호출해 임의 사용자를 '완주'로 표시할 수 있는 pre-existing 취약점.",
  options: [
    { n: 1, label: "지금 서명검증 넣고 켜기", action_preview: "🔒 가짜 완주로 선물 빼가는 길 원천 차단" },
    { n: 2, label: "이메일 먼저 켜고 다음에", action_preview: "🔥 노출 감수하고 속도 우선" },
    { n: 3, label: "완주 API를 인증 뒤로", action_preview: "🔒 근본 차단(범위 큼)" },
  ],
  allow_freetext: true,
};

console.log("결정 넣는 중... 패널에서 답하면 여기 결과가 뜹니다.");
const res = await fetch(`${orchUrl}/internal/decisions`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-fleet-session": "seed" },
  body: JSON.stringify(req),
});
const answer = (await res.json()) as DecisionAnswer;
console.log("받은 답:", answer);
