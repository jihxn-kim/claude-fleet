# 함대 세션 띄우기 (Phase 1)

## 0. 사전 설치 (최초 1회)
```bash
brew install tmux            # 세션 터미널
brew install --cask tailscale  # 또는 App Store 'Tailscale' 설치
```
- 맥과 폰 모두 Tailscale 앱 로그인(같은 계정 = 같은 tailnet).
- 맥의 tailnet 이름 확인: `tailscale status`(맨 위 줄이 이 맥). 예: `my-mac.tailXXXX.ts.net`.

## 1. 오케스트레이터 실행 (상시)
```bash
cd ~/Desktop/claude-fleet
FLEET_PANEL_TOKEN='원하는-긴-토큰' npm start
```
- 로컬 패널: `http://127.0.0.1:4179/?token=원하는-긴-토큰`
- 폰 패널(집 밖 포함): `http://<맥 tailnet 이름>:4179/?token=원하는-긴-토큰`

## 2. 세션에 함대 MCP 붙이기 (프로젝트별 1회)
대상 프로젝트 폴더에서:
```bash
claude mcp add fleet \
  --env FLEET_URL=http://127.0.0.1:4179 \
  --env FLEET_SESSION_TOKEN=session-1 \
  -- /Users/kimjihun/Desktop/claude-fleet/node_modules/.bin/tsx \
     /Users/kimjihun/Desktop/claude-fleet/src/mcpBridge.ts
```

## 3. auto 모드로 세션 시작 (tmux 안)
```bash
tmux new -s proj1
claude --permission-mode acceptEdits \
  --append-system-prompt "$(cat /Users/kimjihun/Desktop/claude-fleet/fleet-rule.txt)"
```
- `tmux attach -t proj1` 로 다시 붙고, `Ctrl-b d` 로 떼어놓는다(세션은 계속 삶).

## 4. E2E 확인
세션 프롬프트에 예: "지금 상황에서 결정이 필요하면 request_decision으로 물어봐" 같은
결정 유발 작업을 준다 → 폰 패널에 카드가 뜨는지 → 번호/메모로 답 → 세션이 이어지는지 확인.

## Phase 2 — 세션 관리 (fleet)

### fleet CLI 별칭 (1회)
```bash
alias fleet='FLEET_PANEL_TOKEN=원하는-긴-토큰 tsx /Users/kimjihun/Desktop/claude-fleet/src/cli.ts'
```
(오케스트레이터를 같은 `FLEET_PANEL_TOKEN`으로 `npm start` 해둔다.)

### 프로젝트 등록 (1회)
```bash
fleet project add daggle /Users/kimjihun/work/daggle
fleet project add printtie /Users/kimjihun/work/printtie
```
또는 `data/projects.json` 직접 편집: `{ "daggle": { "path": "/…/daggle" } }`.

### 세션 관리
```bash
fleet new daggle        # 새 세션(프로젝트당 running 최대 2)
fleet ls                # 세션 목록(●=running ○=stopped, ⚠️=주목)
fleet attach <id>       # 맥에서 포그라운드로 (히스토리 그대로 보임; Ctrl-b d 로 떼기)
fleet kill <id>         # 닫기(tmux 종료, resume 가능하게 유지)
fleet resume <id>       # 닫힌 세션 대화 복원
```
패널(폰)에서도 같은 동작을 버튼으로: 프로젝트별 "+ 새 세션" / resume / 닫기 / 맥에서 열기.

### Notification 안전망 (선택)
세션이 request_decision이 아닌 네이티브 프롬프트에서 멈추면 패널에 ⚠️ 를 띄우려면, Claude Code Notification 훅에서 오케스트레이터로 POST 하도록 설정한다(세션의 `--settings` 또는 사용자 설정):
```jsonc
// hooks: Notification
// curl -s -X POST http://127.0.0.1:4179/internal/notify \
//   -H 'content-type: application/json' \
//   -d "{\"sessionId\":\"$FLEET_SESSION_ID\",\"message\":\"needs attention\"}"
```
(세션 id를 훅에 전달하는 정확한 변수는 Claude Code 훅 스펙에 맞춰 채운다.)
