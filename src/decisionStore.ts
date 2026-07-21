import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DecisionRequest, DecisionAnswer, PendingDecisionView } from "./types.js";

interface Pending {
  id: string;
  sessionToken: string;
  request: DecisionRequest;
  createdAt: string;
  resolve: (a: DecisionAnswer) => void;
  reject: (e: unknown) => void;
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
    let reject!: (e: unknown) => void;
    const answer = new Promise<DecisionAnswer>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.pending.set(id, { id, sessionToken, request, createdAt: this.now(), resolve, reject });
    return { id, answer };
  }

  list(): PendingDecisionView[] {
    return [...this.pending.values()].map(({ resolve: _resolve, reject: _reject, ...view }) => view);
  }

  answer(id: string, ans: DecisionAnswer): boolean {
    const pd = this.pending.get(id);
    if (!pd) return false;
    this.pending.delete(id);
    this.appendHistory(pd, ans);
    pd.resolve(ans);
    return true;
  }

  /** Drop a still-pending decision without writing history (e.g. the requesting
   *  session disconnected before answering); rejects its promise so any awaiter
   *  unwinds. Returns false if it was already answered or removed. */
  abort(id: string): boolean {
    const pd = this.pending.get(id);
    if (!pd) return false;
    this.pending.delete(id);
    pd.reject(new Error("decision aborted"));
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
