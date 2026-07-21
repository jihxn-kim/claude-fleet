import { join } from "node:path";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { DecisionStore } from "./decisionStore.js";
import { SessionStore } from "./sessionStore.js";
import { SessionManager, type CommandRunner } from "./sessionManager.js";
import { createServer } from "./webServer.js";
import { CONFIG } from "./config.js";

const repoRoot = process.cwd();
const decisions = new DecisionStore(CONFIG.historyPath);
const sessionStore = new SessionStore(
  join(CONFIG.dataDir, "sessions.json"),
  join(CONFIG.dataDir, "projects.json"),
);
const realRunner: CommandRunner = {
  run: (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }),
};
const sessions = new SessionManager({
  store: sessionStore,
  runner: realRunner,
  repoRoot,
  orchUrl: `http://127.0.0.1:${CONFIG.port}`,
  mcpDir: join(CONFIG.dataDir, "mcp"),
  ruleText: readFileSync(join(repoRoot, "fleet-rule.txt"), "utf8"),
});

const publicDir = join(repoRoot, "public");
const server = createServer(decisions, { panelToken: CONFIG.panelToken, publicDir, sessions });

server.listen(CONFIG.port, () => {
  console.log(`fleet orchestrator on http://127.0.0.1:${CONFIG.port}`);
  console.log(`panel: http://127.0.0.1:${CONFIG.port}/?token=${CONFIG.panelToken}`);
  if (CONFIG.panelToken === "change-me-please") {
    console.warn("⚠️  FLEET_PANEL_TOKEN 기본값 사용 중 — 실제 토큰으로 교체하세요.");
  }
  sessions.reconcile(); // boot-time reconcile
  setInterval(() => {
    try {
      sessions.reconcile();
    } catch (e) {
      console.error("reconcile error:", e);
    }
  }, 5000);
});
