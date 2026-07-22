import { join } from "node:path";

const dataDir = process.env.FLEET_DATA_DIR ?? join(process.cwd(), "data");

export const CONFIG = {
  port: Number(process.env.FLEET_PORT ?? 4179),
  panelToken: process.env.FLEET_PANEL_TOKEN ?? "change-me-please",
  dataDir,
};
