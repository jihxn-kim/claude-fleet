# Claude 함대 컨트롤 — Phase 2 (세션 생명주기) 설계 문서

- 작성일: 2026-07-21
- 상태: Phase 2 스펙 (Phase 1 완료·검증 위에 얹음)
- 전제: Phase 1(결정 루프) 완료. `~/Desktop/claude-fleet` main, `npm test` 통과, 실제 세션 E2E 증명됨.

## 1. 문제 / 목표

Phase 1으로 "세션이 물으면 폰 카드 → 답 → 이어감" 루프는 됐다. 하지만 세션을 **띄우고/이어가고/닫는 건 아직 손으로** 한다(BOOTSTRAP 명령). 세션이 많아지면 이 관리가 부담이다.

Phase 2 목표: **오케스트레이터가 세션 생명주기를 관리**한다.
- 프로젝트별로 세션 **띄우기 / 이어가기(resume) / 닫기**를 패널 버튼·CLI로.
- 프로젝트당 **running 최대 2** 강제.
- 패널·CLI에 **세션 목록**(어느 프로젝트에 무슨 세션이 살아있는지).
- **tmux 생사 동기화**: 패널에서 닫으면 tmux kill, 직접 tmux를 죽이면 패널이 감지해 반영.
- 세션은 **백그라운드(detached tmux) 기본**, 맥에서 볼 땐 포그라운드로 꺼내면(attach) **그간의 대화·출력 히스토리 그대로** 보임.

## 2. 확정된 결정 사항

| 항목 | 결정 |
|---|---|
| 세션 = tmux | 세션 1개 = detached tmux 1개, 백그라운드 기본 |
| 맥에서 보기 | 필요 시 포그라운드로 꺼내기(attach) — CLI `fleet attach` / 패널 "맥에서 열기"(osascript로 Terminal 창) |
| 조작 위치 | **패널 버튼 + CLI 둘 다** |
| 세션 id | `claude --session-id <uuid>`로 **우리가 생성한 uuid** 지정. 이 uuid = claude 세션id = fleet 세션토큰(통일) |
| 이어가기 | `claude --resume <uuid>` (인터랙티브, tmux) |
| auto 모드 | `--permission-mode acceptEdits` + fleet-rule + `--allowedTools mcp__fleet__request_decision` |
| 세션 상한 | 프로젝트당 running 2 |

## 3. 스코프

**포함(Phase 2):**
- 프로젝트 레지스트리(`projects.json`), 세션 레지스트리(`sessions.json`, 영속)
- 세션 런처(새로/resume/닫기), 프로젝트당 running 최대 2 강제
- tmux 생사 폴링 동기화 + 오케스트레이터 재시작 시 정합성 복구
- CLI `fleet`(new/ls/resume/kill/attach/project add)
- 패널 세션 목록 뷰 + 버튼(띄우기/resume/닫기/맥에서 열기)
- 다중 세션 결정 라우팅(카드에 어느 프로젝트/세션인지 표시)
- Notification 안전망(세션이 네이티브 프롬프트 등에서 멈추면 패널에 표시)

**제외(→ Phase 3):**
- 카드 풀스타일, 음성 입력, 파일 첨부, 자동 저장, 결정/세션 히스토리 UI

## 4. 아키텍처 / 컴포넌트

Phase 1의 단일 오케스트레이터 프로세스에 얹는다. 오케스트레이터가 맥에서 도므로 tmux/osascript를 직접 실행할 수 있다.

### 4.1 프로젝트 레지스트리 (`data/projects.json`)
- `{ name → { path } }`. 예: `{ "daggle": { "path": "/Users/kimjihun/work/daggle" } }`.
- CLI `fleet project add <name> <path>` / 수동 편집. 패널·CLI가 목록으로 노출.

### 4.2 세션 레지스트리 (`data/sessions.json`, 영속)
엔트리:
```jsonc
{
  "id": "e3b0c442-...-uuid",      // = claude 세션id = fleet 토큰 = tmux 이름의 접미
  "project": "daggle",
  "projectPath": "/Users/kimjihun/work/daggle",
  "tmuxName": "fleet__daggle__e3b0c4",
  "status": "running",            // running | stopped
  "startedAt": "2026-07-21T...",
  "lastSeen": "2026-07-21T..."
}
```
- 오케스트레이터 재시작에도 유지. 재시작 시 tmux 실황과 대조해 정합성 복구(§4.7).

### 4.3 세션 매니저 (`src/sessionManager.ts`)
tmux/osascript/uuid를 다루는 순수 로직 + 레지스트리 CRUD. HTTP/CLI가 이걸 호출.
- `list()` / `get(id)`
- `launch(project)`: 상한 검사 → uuid 생성 → per-session mcp config 작성 → tmux new-session -d → 등록. (§5)
- `resume(id)`: stopped 엔트리 → `claude --resume <id>`로 tmux 재생성 → running.
- `close(id)`: `tmux kill-session` → stopped(엔트리·uuid 유지).
- `openTerminal(id)`: osascript로 Terminal 창 열고 `tmux attach -t <name>`.
- `reconcile()`: `tmux list-sessions`와 대조(§4.7).

### 4.4 런처 실행 커맨드 (검증된 flag)
tmux 안에서 실행되는 claude:
```bash
tmux new-session -d -s "<tmuxName>" -c "<projectPath>" \
  "claude --session-id <uuid> \
    --permission-mode acceptEdits \
    --append-system-prompt \"$(cat /Users/kimjihun/Desktop/claude-fleet/fleet-rule.txt)\" \
    --mcp-config <data/mcp/<uuid>.json> \
    --strict-mcp-config \
    --allowedTools mcp__fleet__request_decision"
```
- resume는 `--session-id <uuid>` 대신 `--resume <uuid>`.
- **구현 주의:** 위 명령은 개념 표기. 실제로는 셸 문자열로 조립하지 말고 `spawn("tmux", ["new-session","-d","-s",name,"-c",path,"claude","--session-id",uuid, … ,"--append-system-prompt",ruleText, …])` 처럼 **argv 배열**로 넘겨 따옴표/`$(...)` 이스케이프 지옥을 피한다(fleet-rule 내용은 Node가 `readFileSync`로 읽어 인자로 전달).
- per-session mcp config `data/mcp/<uuid>.json`: Phase 1 브릿지를 그 세션 토큰으로 붙인다.
```jsonc
{ "mcpServers": { "fleet": {
  "command": "/Users/kimjihun/Desktop/claude-fleet/node_modules/.bin/tsx",
  "args": ["/Users/kimjihun/Desktop/claude-fleet/src/mcpBridge.ts"],
  "env": { "FLEET_URL": "http://127.0.0.1:4179", "FLEET_SESSION_TOKEN": "<uuid>" }
}}}
```

### 4.5 오케스트레이터 HTTP 추가 (패널·CLI 공용, 토큰 가드)
- `GET  /api/sessions` → 세션 목록(프로젝트별). 
- `GET  /api/projects` → 프로젝트 목록.
- `POST /api/sessions` body `{project}` → launch. 상한 초과 시 409 `{error:"max 2 running"}`.
- `POST /api/sessions/:id/resume` → resume.
- `POST /api/sessions/:id/close` → close.
- `POST /api/sessions/:id/open-terminal` → 맥에서 Terminal 창 열기(osascript).
- `POST /api/projects` body `{name,path}` → 프로젝트 추가.

### 4.6 CLI (`src/cli.ts`, 오케스트레이터 HTTP를 호출)
`fleet <cmd>` — 단일 소스(오케스트레이터 레지스트리)를 건드리도록 전부 HTTP 경유.
| 명령 | 동작 |
|---|---|
| `fleet new <project>` | POST /api/sessions |
| `fleet ls` | GET /api/sessions (표로 출력) |
| `fleet resume <id\|이름>` | POST …/resume |
| `fleet kill <id\|이름>` | POST …/close |
| `fleet attach <id\|이름>` | 로컬에서 `tmux attach -t <tmuxName>` (현재 터미널 점유) |
| `fleet project add <name> <path>` | POST /api/projects |
- 토큰은 env `FLEET_PANEL_TOKEN`에서. 셸 alias: `alias fleet='FLEET_PANEL_TOKEN=… tsx ~/Desktop/claude-fleet/src/cli.ts'`.

### 4.7 생사 동기화 (`reconcile`, 주기 폴링)
- 오케스트레이터가 N초(기본 5s)마다 `tmux list-sessions -F '#{session_name}'`로 살아있는 `fleet__*` 집합을 구한다.
- running인데 목록에 없는 엔트리 → **stopped**로 전환 + `lastSeen` 갱신(직접 kill 감지).
- 패널 close는 즉시 kill + stopped. 재시작 시 부팅 직후 1회 reconcile.

### 4.8 다중 세션 결정 라우팅
- Phase 1에서 결정의 `sessionToken`이 이제 **세션 uuid**다(하드코딩 `session-1` 대체).
- 패널 카드는 `sessionToken`→세션 레지스트리 매핑으로 **"프로젝트 daggle · 세션 e3b0c4"** 를 함께 표시.
- 여러 세션이 동시에 물으면 카드가 여러 장 쌓인다(Phase 1 패널은 첫 장만 → Phase 2에서 목록/스택으로 확장).

### 4.9 Notification 안전망
- 세션이 request_decision으로 라우팅되지 않은 네이티브 프롬프트/알림에서 멈추면, Claude Code **Notification 훅**이 오케스트레이터 `POST /internal/notify {sessionId, message}`를 친다.
- 패널이 해당 세션에 "⚠️ 주목 필요" 배지를 띄운다. (놓침 방지; 최소 표시.)
- 훅은 세션별 `--settings` 또는 사용자 설정으로 1회 구성(BOOTSTRAP에 문서화).

## 5. 데이터 흐름 (새 세션)

```
패널/CLI ──POST /api/sessions {project}──▶ 오케스트레이터
                                            │ 상한검사(running<2)
                                            │ uuid 생성 + data/mcp/<uuid>.json 작성
                                            │ tmux new-session -d (claude --session-id <uuid> …)
                                            │ sessions.json 등록(running)
                                            ▼
                              (세션이 결정 필요 → Phase 1 루프로 카드 push, sessionToken=uuid)
```

## 6. 상태 / 저장
- `data/projects.json`, `data/sessions.json` (영속, gitignore).
- `data/mcp/<uuid>.json` per-session mcp config.
- 인메모리 pending 결정(Phase 1) 그대로.

## 7. 에러 / 엣지
- 상한 초과 launch → 409, 아무 것도 안 만듦.
- resume 대상이 running이거나 없음 → 409/404.
- close 대상이 이미 stopped/없음 → 멱등(200/404).
- 존재하지 않는 project로 new → 400.
- 오케스트레이터 재시작: 부팅 시 reconcile로 running/stopped 정합성 복구. (죽어있던 tmux는 stopped로.)
- tmux 미설치/명령 실패 → 500 + 명확한 메시지.
- 세션 uuid 충돌: `crypto.randomUUID()`라 사실상 없음.

## 8. 테스트 전략 (TDD)
- **단위:** 상한 검사(running<2), 레지스트리 CRUD/영속, reconcile 로직(주어진 live 집합 → 상태 전이), tmux 커맨드 빌더(문자열 생성만, 실행은 주입된 러너 mock).
- **통합:** HTTP `/api/sessions` CRUD를 **주입된 가짜 tmux 러너**로 검증(실제 tmux 없이 launch→ls→close→resume 흐름, 상한 409, reconcile 반영). CLI가 그 엔드포인트를 올바로 호출하는지.
- **수동 E2E:** 실제 tmux로 `fleet new <proj>` → `fleet ls`에 running → 패널에 세션 표시 → 세션이 request_decision 하면 카드에 프로젝트/세션 표기 → `fleet kill` 또는 직접 `tmux kill-session` → 패널/ls 반영. `fleet attach`로 히스토리 보임 확인. `fleet resume`로 대화 복원 확인.

## 9. 완료 기준 (수용 기준)
1. `fleet new <project>` / 패널 버튼으로 세션이 뜨고 `sessions.json`·`fleet ls`·패널에 running으로 보인다.
2. 같은 프로젝트에서 3번째 launch는 409로 거절된다(최대 2).
3. 세션이 request_decision 하면 카드에 **어느 프로젝트/세션인지** 표시된다.
4. 패널/`fleet kill`로 닫으면 tmux가 죽고 stopped로 반영된다.
5. 직접 `tmux kill-session` 하면 폴링이 감지해 stopped로 반영된다.
6. `fleet resume <id>`로 닫힌 세션이 대화 히스토리와 함께 복원된다.
7. `fleet attach` / 패널 "맥에서 열기"로 세션을 포그라운드로 꺼내면 그간 히스토리가 보인다.

## 10. 열린 항목 / 기본값
- 폴링 주기 기본 5s(설정 가능).
- tmux 세션 이름: `fleet__<projectSlug>__<uuid앞6자>`.
- 패널 세션 뷰: Phase 2는 목록+버튼 최소 스타일(풀스타일 Phase 3).
- Notification 훅 구성 방식(세션별 `--settings` vs 사용자 전역): 구현 시 Claude Code 훅 스펙 확인해 확정.
- 여러 카드 동시 표시: Phase 2에서 스택/목록으로. (Phase 1은 첫 장만)
