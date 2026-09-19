import { loadEnvConfig } from "@next/env";
import { isAddress } from "viem";
loadEnvConfig(process.cwd());
async function main() {
  const [contract, site = process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL] = process.argv.slice(2);
  if (!contract || !isAddress(contract, { strict: false }) || !site) throw new Error("Usage: npm run set-contract -- 0xContract https://hoodball.net (site may be supplied by SITE_URL)");
  const url = new URL(site);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Remote configuration requires HTTPS");
  const token = process.env.HOODBALL_ADMIN_TOKEN;
  if (!token) throw new Error("HOODBALL_ADMIN_TOKEN is required");
  const response = await fetch(new URL("/api/config", url), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ tokenAddress: contract }), signal: AbortSignal.timeout(180000) });
  const result = await response.json() as { config?: { tokenAddress: string; tokenSymbol: string; startBlock: number }; error?: string };
  if (!response.ok || !result.config) throw new Error(result.error ?? `Configuration failed (${response.status})`);
  console.log(`Configured ${result.config.tokenSymbol} ${result.config.tokenAddress} from deployment block ${result.config.startBlock}. Indexing begins automatically; no redeploy required.`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Token configuration failed"); process.exitCode = 1; });
