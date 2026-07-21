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
