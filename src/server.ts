import { join } from "node:path";
import { DecisionStore } from "./decisionStore.js";
import { createServer } from "./webServer.js";
import { CONFIG } from "./config.js";

const store = new DecisionStore(CONFIG.historyPath);
const publicDir = join(process.cwd(), "public");
const server = createServer(store, { panelToken: CONFIG.panelToken, publicDir });

server.listen(CONFIG.port, () => {
  console.log(`fleet orchestrator on http://127.0.0.1:${CONFIG.port}`);
  console.log(`panel: http://127.0.0.1:${CONFIG.port}/?token=${CONFIG.panelToken}`);
  if (CONFIG.panelToken === "change-me-please") {
    console.warn("⚠️  FLEET_PANEL_TOKEN 기본값 사용 중 — 실제 토큰으로 교체하세요.");
  }
});
