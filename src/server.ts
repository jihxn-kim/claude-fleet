import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { SessionStore } from "./sessionStore.js";
import { SessionManager, type CommandRunner } from "./sessionManager.js";
import { createServer } from "./webServer.js";
import { CONFIG } from "./config.js";

const repoRoot = process.cwd();
const sessionStore = new SessionStore(
  join(CONFIG.dataDir, "sessions.json"),
  join(CONFIG.dataDir, "projects.json"),
);
const realRunner: CommandRunner = {
  // stdio: capture stdout, capture (don't inherit) stderr so tmux's benign
  // "no server running" on idle reconcile doesn't spam the launchd err log.
  run: (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
};
const sessions = new SessionManager({
  store: sessionStore,
  runner: realRunner,
  repoRoot,
  orchUrl: `http://127.0.0.1:${CONFIG.port}`,
  mcpDir: join(CONFIG.dataDir, "mcp"),
  ruleText: readFileSync(join(repoRoot, "fleet-rule.txt"), "utf8"),
  claudeProjectsDir: join(homedir(), ".claude", "projects"),
  configPath: join(CONFIG.dataDir, "config.json"),
});

const publicDir = join(repoRoot, "public");
const server = createServer({ panelToken: CONFIG.panelToken, publicDir, sessions });

server.listen(CONFIG.port, () => {
  console.log(`fleet orchestrator on http://127.0.0.1:${CONFIG.port}`);
  console.log(`panel: http://127.0.0.1:${CONFIG.port}/?token=${CONFIG.panelToken}`);
  if (CONFIG.panelToken === "change-me-please") {
    console.warn("⚠️  FLEET_PANEL_TOKEN 기본값 사용 중 — 실제 토큰으로 교체하세요.");
  }
  try {
    sessions.reconcile(); // boot-time reconcile
  } catch (e) {
    console.error("boot reconcile error:", e);
  }
  setInterval(() => {
    try {
      sessions.reconcile();
    } catch (e) {
      console.error("reconcile error:", e);
    }
  }, 5000);
  // Sample session activity (busy/idle) on a fixed cadence, independent of panel polls.
  setInterval(() => {
    try {
      sessions.sampleActivity();
    } catch (e) {
      console.error("sampleActivity error:", e);
    }
  }, 2000);
});
