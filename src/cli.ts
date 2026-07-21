import { execFileSync } from "node:child_process";

export type CliAction =
  | { kind: "http"; method: "GET" | "POST"; path: string; body?: unknown; render?: "sessions" | "projects" | "available" }
  | { kind: "attach-id"; id: string }
  | { kind: "error"; message: string };

export function resolveCommand(argv: string[]): CliAction {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "new":
      if (!rest[0]) return { kind: "error", message: "usage: fleet new <project>" };
      return { kind: "http", method: "POST", path: "/api/sessions", body: { project: rest[0] } };
    case "ls":
      return { kind: "http", method: "GET", path: "/api/sessions", render: "sessions" };
    case "resume":
      if (!rest[0]) return { kind: "error", message: "usage: fleet resume <id>" };
      return { kind: "http", method: "POST", path: `/api/sessions/${rest[0]}/resume` };
    case "kill":
      if (!rest[0]) return { kind: "error", message: "usage: fleet kill <id>" };
      return { kind: "http", method: "POST", path: `/api/sessions/${rest[0]}/close` };
    case "attach":
      if (!rest[0]) return { kind: "error", message: "usage: fleet attach <id>" };
      return { kind: "attach-id", id: rest[0] };
    case "project":
      if (rest[0] === "add" && rest[1] && rest[2]) {
        return { kind: "http", method: "POST", path: "/api/projects", body: { name: rest[1], path: rest[2] } };
      }
      return { kind: "error", message: "usage: fleet project add <name> <path>" };
    case "discover":
      if (!rest[0]) return { kind: "error", message: "usage: fleet discover <project>" };
      return { kind: "http", method: "GET", path: `/api/projects/${rest[0]}/available`, render: "available" };
    case "adopt":
      if (!rest[0] || !rest[1]) return { kind: "error", message: "usage: fleet adopt <session-id> <project>" };
      return { kind: "http", method: "POST", path: "/api/sessions/adopt", body: { id: rest[0], project: rest[1] } };
    default:
      return { kind: "error", message: `unknown command: ${cmd ?? "(none)"}\nfleet new|ls|resume|kill|attach|project add` };
  }
}

const ORCH = process.env.FLEET_URL ?? "http://127.0.0.1:4179";
const TOKEN = process.env.FLEET_PANEL_TOKEN ?? "";

function withToken(path: string): string {
  return `${ORCH}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}`;
}

async function apiSessions(): Promise<Array<{ id: string; tmuxName: string }>> {
  return (await (await fetch(withToken("/api/sessions"))).json()) as Array<{ id: string; tmuxName: string }>;
}

async function main(): Promise<void> {
  const action = resolveCommand(process.argv.slice(2));
  if (action.kind === "error") {
    console.error(action.message);
    process.exit(1);
  }
  if (action.kind === "attach-id") {
    const s = (await apiSessions()).find((x) => x.id === action.id || x.tmuxName.endsWith(action.id));
    if (!s) {
      console.error(`no session ${action.id}`);
      process.exit(1);
    }
    execFileSync("tmux", ["attach", "-t", s.tmuxName], { stdio: "inherit" });
    return;
  }
  const res = await fetch(withToken(action.path), {
    method: action.method,
    headers: action.body ? { "content-type": "application/json" } : {},
    body: action.body ? JSON.stringify(action.body) : undefined,
  });
  const data = await res.json();
  if (action.render === "sessions" && Array.isArray(data)) {
    for (const s of data as Array<Record<string, string>>) {
      const notice = (s as any).notice ? "  ⚠️" : "";
      console.log(`${s.status === "running" ? "●" : "○"} ${s.project.padEnd(12)} ${s.tmuxName}  ${s.id}${notice}`);
    }
  } else if (action.render === "available" && Array.isArray(data)) {
    if (data.length === 0) console.log("(가져올 세션 없음)");
    for (const a of data as Array<{ id: string; mtime: string; snippet: string }>) {
      console.log(`${a.id}  ${a.mtime.slice(0, 16).replace("T", " ")}  ${a.snippet || "(스니펫 없음)"}`);
    }
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
  if (!res.ok) process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith("cli.ts")) {
  void main();
}
