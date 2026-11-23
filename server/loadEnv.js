/**
 * Load local env for the history API.
 * Priority: process env → server/.env → repo-root .env
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const candidates = [
  path.join(__dirname, ".env"),
  path.join(root, ".env"),
];

for (const file of candidates) {
  if (!fs.existsSync(file)) continue;
  dotenv.config({ path: file, override: false });
  console.info(`[env] loaded ${path.relative(root, file)}`);
}
