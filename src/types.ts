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
