import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DecisionRequest, DecisionAnswer, PendingDecisionView } from "./types.js";

interface Pending {
  id: string;
  sessionToken: string;
  request: DecisionRequest;
  createdAt: string;
  resolve: (a: DecisionAnswer) => void;
}

export class DecisionStore {
  private pending = new Map<string, Pending>();
  private seq = 0;

  constructor(
    private historyPath: string,
    private now: () => string = () => new Date().toISOString(),
  ) {}

  create(sessionToken: string, request: DecisionRequest): { id: string; answer: Promise<DecisionAnswer> } {
    const id = `d${++this.seq}`;
    let resolve!: (a: DecisionAnswer) => void;
    const answer = new Promise<DecisionAnswer>((r) => (resolve = r));
    this.pending.set(id, { id, sessionToken, request, createdAt: this.now(), resolve });
    return { id, answer };
  }

  list(): PendingDecisionView[] {
    return [...this.pending.values()].map(({ resolve: _resolve, ...view }) => view);
  }

  answer(id: string, ans: DecisionAnswer): boolean {
    const pd = this.pending.get(id);
    if (!pd) return false;
    this.pending.delete(id);
    this.appendHistory(pd, ans);
    pd.resolve(ans);
    return true;
  }

  private appendHistory(pd: Pending, ans: DecisionAnswer): void {
    const line = JSON.stringify({
      id: pd.id,
      sessionToken: pd.sessionToken,
      request: pd.request,
      answer: ans,
      createdAt: pd.createdAt,
      answeredAt: this.now(),
    });
    mkdirSync(dirname(this.historyPath), { recursive: true });
    appendFileSync(this.historyPath, line + "\n");
  }
}
