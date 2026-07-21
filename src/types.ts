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
}

export interface DecisionAnswer {
  choice?: number;
  memo?: string;
}

export interface PendingDecisionView {
  id: string;
  sessionToken: string;
  request: DecisionRequest;
  createdAt: string;
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
