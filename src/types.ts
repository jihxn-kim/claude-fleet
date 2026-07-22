export interface DecisionOption {
  n: number;
  label: string;
  action_preview?: string;
}

export interface DecisionRequest {
  title: string;
  why_now: string;
  payoff: string;
  tradeoff: string;
  context?: string;
  options: DecisionOption[];
  allow_freetext: boolean;
  multi_select?: boolean; // true면 옵션을 여러 개 동시에 고를 수 있음
}

export interface DecisionAnswer {
  choice?: number; // 단일 선택
  choices?: number[]; // 다중 선택 (multi_select 문항)
  memo?: string;
}

export interface PendingDecisionView {
  id: string;
  sessionToken: string;
  request: DecisionRequest;
  createdAt: string;
}

// A native on-screen selection menu detected in a session (permission prompt,
// AskUserQuestion, plan approval, yes/no, …) — mirrored to the panel.
export interface PromptOption {
  n: number;
  label: string;
}
export interface SessionPrompt {
  title: string;
  options: PromptOption[];
}

export type SessionStatus = "running" | "stopped";

export interface SessionEntry {
  id: string; // uuid = claude session id = fleet token
  project: string;
  projectPath: string;
  tmuxName: string;
  status: SessionStatus;
  startedAt: string;
  lastSeen: string;
  label?: string; // user-friendly name shown in the panel
}

export interface ProjectEntry {
  name: string;
  path: string;
}

export interface AvailableSession {
  id: string;
  mtime: string; // ISO, 세션 파일 최종 수정시각
  snippet: string; // 첫 user 메시지 일부
}

// A session found by scanning ALL of ~/.claude/projects (no registration needed).
export interface AllSession {
  id: string;
  projectPath: string; // real cwd from the session file
  projectName: string; // basename of projectPath
  mtime: string; // ISO
  snippet: string;
  running: boolean; // a live claude process has this cwd
}
