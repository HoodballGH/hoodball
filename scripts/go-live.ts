import { loadEnvConfig } from "@next/env";
import { isAddress } from "viem";
loadEnvConfig(process.cwd());
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(site: URL, token: string, body: unknown) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(new URL("/api/config", site), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
    const result = (await response.json()) as {
      config?: Record<string, unknown>;
      error?: string;
    };
    if (response.ok && result.config) return result.config;
    const busy =
      response.status === 409 &&
      /retry|processing|draw/i.test(result.error ?? "");
    if ((busy || response.status === 503) && attempt < 30) {
      process.stdout.write("~");
      await sleep(3000);
      continue;
    }
    throw new Error(
      result.error ?? `Configuration failed (${response.status})`,
    );
  }
}

async function main() {
  const [contract, site = process.env.SITE_URL] = process.argv.slice(2);
  if (!contract || !isAddress(contract, { strict: false }) || !site)
    throw new Error(
      "Usage: npm run go-live -- 0xTokenContract [https://hoodball.net]",
    );
  const url = new URL(site);
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(url.hostname)
  )
    throw new Error("Remote configuration requires HTTPS");
  const token = process.env.HOODBALL_ADMIN_TOKEN;
  if (!token) throw new Error("HOODBALL_ADMIN_TOKEN is required");
  const current = (await (await fetch(new URL("/api/config", url))).json()) as {
    tokenAddress: string | null;
    vaultAddress: string | null;
  };
  if (!current.vaultAddress)
    console.log(
      "No vault address yet: the server derives it from HOODBALL_VAULT_PRIVATE_KEY at the next worker tick, or set it with npm run configure.",
    );
  if (!current.tokenAddress) {
    const config = await post(url, token, { tokenAddress: contract });
    console.log(
      `Token ${config.tokenSymbol} configured from block ${config.startBlock}. Indexing started.`,
    );
  } else if (current.tokenAddress.toLowerCase() !== contract.toLowerCase())
    throw new Error(`Site already tracks ${current.tokenAddress}`);
  else console.log(`Token ${contract} was already configured.`);
  process.stdout.write("Waiting for the indexer to reach live");
  for (let attempt = 0; attempt < 360; attempt++) {
    const health = (await (
      await fetch(new URL("/api/health", url))
    ).json()) as {
      status: string;
      indexedBlock: number | null;
      drawsEnabled: boolean;
      drawGate: string;
      nextDrawAt: string;
    };
    if (health.status === "live") {
      console.log(`\nLive at block ${health.indexedBlock}.`);
      if (!health.drawsEnabled) {
        await post(url, token, { drawsEnabled: true });
        console.log("Draws resumed.");
      }
      const snapshot = (await (
        await fetch(new URL("/api/snapshot", url))
      ).json()) as {
        draws: { gate: string; nextDrawAt: string; intervalSeconds: number };
        jackpot: { potEth: string };
      };
      console.log(
        `Draw gate: ${snapshot.draws.gate}. Next draw at ${snapshot.draws.nextDrawAt} (every ${snapshot.draws.intervalSeconds}s). Pot: ${snapshot.jackpot.potEth} ETH.`,
      );
      if (snapshot.draws.gate !== "ok")
        console.log(
          `Draws will not pay until the gate reads ok (now: ${snapshot.draws.gate}). Check MONEY_ENABLED, HOODBALL_VAULT_PRIVATE_KEY and HOODBALL_TREASURY_ENABLED on the service; no redeploy is needed for the token.`,
        );
      return;
    }
    process.stdout.write(".");
    await sleep(5000);
  }
  throw new Error(
    "\nIndexer did not reach live within 30 minutes; check /api/health",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Go-live failed");
  process.exitCode = 1;
});
