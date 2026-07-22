# claude-fleet

여러 Claude Code 세션을 한곳에서 관리하는 오케스트레이터 + 폰용 결정 패널.

세션들은 auto 모드로 자율 진행하고, **진짜 결정이 필요할 때만** 맥락을 스스로 정리해 폰 패널에 카드로 올린다. 1·2·3 / 메모로 답하면 그 답이 세션에 리턴되어 이어서 일한다.

## 구성

- **오케스트레이터** (`src/server.ts` + `src/webServer.ts`): 맥에서 상시 도는 단일 HTTP 프로세스. 결정 큐 + 세션 레지스트리 + 웹 패널 서빙 + tmux 관리.
- **stdio MCP 브릿지** (`src/mcpBridge.ts`): 각 세션에 붙는 MCP 서버. `request_decision` 툴 하나를 노출 — 세션이 이걸 호출하면 오케스트레이터로 넘어가 응답이 올 때까지 블로킹된다.
- **웹 패널** (`public/index.html`): 폰/브라우저용 단일 페이지. 결정 카드 + 세션 목록 + 기존 세션 가져오기.
- **세션 매니저** (`src/sessionManager.ts`): tmux로 세션 띄우기/이어가기/닫기, 프로젝트당 최대 2 강제, 생사 동기화, 로컬 세션 스캔/adopt.
- **CLI** (`src/cli.ts`): `fleet new|ls|resume|kill|attach|discover|adopt|project add`.

## 특징

- 로컬 `~/.claude/projects` 전체를 스캔해 **기존 세션을 등록 없이** 목록화(실행 중 표시), 골라서 fleet로 adopt(`--fork-session`으로 히스토리 유지).
- 결정 채널은 MCP 툴 1개. 나머지(오케스트레이션·UI·세션관리)는 평범한 HTTP + tmux.
- 원격 접속은 Tailscale로. `/internal/*`는 loopback 게이트, 패널 API는 토큰 가드.
- "맥에서 열기"는 설치된 터미널(iTerm2/Terminal 등)을 감지해 선택한 것으로 attach.

## 터미널에서 열기 (iTerm2 권장)

패널에서 세션을 **포그라운드**로 열면 설치된 터미널을 감지해 그 세션의 tmux에 붙는다.

- **iTerm2** — `tmux -CC`(네이티브 tmux 통합)로 붙어서 tmux 창이 **진짜 iTerm 창**이 된다. 스크롤·텍스트 선택·클립보드가 전부 네이티브(tmux copy-mode의 커서 따라옴/드래그 튕김 없음).
  - **1회 설정 필요:** iTerm2 → Settings(⌘,) → **General › tmux** → **"Automatically bury the tmux client session after connecting"** 체크.
  - 안 켜면 제어용(backchannel) 창이 하나 더 뜬다. **기계당 한 번만** 하면 되고 세션마다 하는 게 아니다. (plist 키: `AutoHideTmuxClientSession`)
- **그 외 터미널**(Terminal.app 등) — 일반 `tmux attach`로 붙는다. 동작은 하지만 스크롤이 tmux copy-mode를 거쳐서 커서가 따라오거나 드래그 시 맨 아래로 튕길 수 있다. **네이티브 스크롤/선택은 iTerm2에서만** 되는데, 이는 tmux 제어모드(`-CC`)가 iTerm2 전용 기능이기 때문이다.

## 빠른 시작

```bash
npm install
FLEET_PANEL_TOKEN='원하는-긴-토큰' npm start   # 포트 4179
```

세션 붙이기, Tailscale, 프로젝트 등록 등 상세 절차는 [`docs/BOOTSTRAP.md`](docs/BOOTSTRAP.md).

## 개발

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
```

Node 20+ · TypeScript(ESM/NodeNext) · 빌드 없음(tsx). macOS 전용(tmux + osascript).
