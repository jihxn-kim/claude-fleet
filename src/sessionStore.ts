import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionEntry, ProjectEntry, SessionStatus } from "./types.js";

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback; // corrupt/partial file → treat as empty rather than crash
  }
}
function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path); // atomic replace — no truncated file on crash mid-write
}

export class SessionStore {
  constructor(
    private sessionsPath: string,
    private projectsPath: string,
    private now: () => string = () => new Date().toISOString(),
  ) {}

  listProjects(): ProjectEntry[] {
    const map = readJson<Record<string, { path: string }>>(this.projectsPath, {});
    return Object.entries(map).map(([name, v]) => ({ name, path: v.path }));
  }
  getProject(name: string): ProjectEntry | undefined {
    return this.listProjects().find((p) => p.name === name);
  }
  addProject(name: string, path: string): ProjectEntry {
    const map = readJson<Record<string, { path: string }>>(this.projectsPath, {});
    map[name] = { path };
    writeJson(this.projectsPath, map);
    return { name, path };
  }

  listSessions(): SessionEntry[] {
    return readJson<SessionEntry[]>(this.sessionsPath, []);
  }
  getSession(id: string): SessionEntry | undefined {
    return this.listSessions().find((s) => s.id === id);
  }
  runningCount(project: string): number {
    return this.listSessions().filter((s) => s.project === project && s.status === "running").length;
  }
  upsert(entry: SessionEntry): void {
    const all = this.listSessions();
    const i = all.findIndex((s) => s.id === entry.id);
    if (i >= 0) all[i] = entry;
    else all.push(entry);
    writeJson(this.sessionsPath, all);
  }
  removeSession(id: string): boolean {
    const all = this.listSessions();
    const next = all.filter((s) => s.id !== id);
    if (next.length === all.length) return false;
    writeJson(this.sessionsPath, next);
    return true;
  }
  setStatus(id: string, status: SessionStatus): SessionEntry | undefined {
    const all = this.listSessions();
    const s = all.find((x) => x.id === id);
    if (!s) return undefined;
    s.status = status;
    s.lastSeen = this.now();
    writeJson(this.sessionsPath, all);
    return s;
  }
}
