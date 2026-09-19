import { loadEnvConfig } from "@next/env";
import { readFile } from "node:fs/promises";
loadEnvConfig(process.cwd());
async function main() {
  const [site, configPath] = process.argv.slice(2);
  if (!site || !configPath) throw new Error("Usage: npm run configure -- https://hoodball.net config.json");
  const url = new URL(site);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Remote configuration requires HTTPS");
  const token = process.env.HOODBALL_ADMIN_TOKEN;
  if (!token) throw new Error("HOODBALL_ADMIN_TOKEN is required");
  const body = await readFile(configPath, "utf8");
  JSON.parse(body);
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(new URL("/api/config", url), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body, signal: AbortSignal.timeout(180000) });
    const result = await response.json() as { error?: string };
    if (response.ok) { console.log(JSON.stringify(result, null, 2)); return; }
    if (response.status === 409 && /retry/i.test(result.error ?? "") && attempt < 40) { await new Promise(resolve => setTimeout(resolve, 1500 + Math.random() * 1500)); continue; }
    throw new Error(`Configuration failed (${response.status}): ${JSON.stringify(result)}`);
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Configuration failed"); process.exitCode = 1; });
