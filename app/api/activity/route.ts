import { formatEther, formatUnits, isAddress } from "viem";
import { EXPLORER_URL, ZERO_ADDRESS } from "@/lib/chain";
import { ensureSchema, pool, readConfig } from "@/lib/db";
import { publicReadCache } from "@/lib/read-cache";
import type { Activity } from "@/lib/types";

export const dynamic = "force-dynamic";

const FEED = `
  SELECT t.tx_hash AS tx_hash, t.log_index::text AS key, t.block_number AS block_number,
         t.timestamp AS ts, t.from_address AS from_address, t.to_address AS to_address,
         t.amount::text AS amount,
         CASE WHEN t.from_address = $2 THEN 'mint'
              WHEN t.to_address = $2 THEN 'burn'
              WHEN c.kind = 'swap' THEN 'swap' ELSE 'transfer' END AS type,
         'token' AS unit
  FROM hoodball.transfers t
  LEFT JOIN hoodball.tx_classifications c ON c.tx_hash = t.tx_hash
  WHERE ($1::text IS NULL OR t.from_address = $1 OR t.to_address = $1)
  UNION ALL
  SELECT p.tx_hash, p.id, COALESCE(p.block_number, 0), COALESCE(p.confirmed_at, p.updated_at),
         $3::text, p.recipient, p.amount_wei::text, 'payout', 'eth'
  FROM hoodball.draw_payouts p
  WHERE p.status = 'confirmed' AND p.tx_hash IS NOT NULL
    AND ($1::text IS NULL OR p.recipient = $1)
`;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const offset = Number(params.get("offset") ?? 0);
  const limit = Number(params.get("limit") ?? 50);
  const address = params.get("address")?.toLowerCase() ?? null;
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 250 ||
    (address && !isAddress(address))
  )
    return Response.json({ error: "Invalid activity query" }, { status: 400 });
  try {
    const body = await publicReadCache.get(
      JSON.stringify(["activity", address, offset, limit]),
      async () => {
        let client;
        try {
          await ensureSchema();
          client = await pool().connect();
          const config = await readConfig(client);
          const args = [address, ZERO_ADDRESS, config.vaultAddress ?? ""];
          const rows = (
            await client.query(
              `SELECT * FROM (${FEED}) feed ORDER BY ts DESC, block_number DESC LIMIT $4 OFFSET $5`,
              [...args, limit, offset],
            )
          ).rows;
          const total = Number(
            (
              await client.query(
                `SELECT count(*)::text AS count FROM (${FEED}) feed`,
                args,
              )
            ).rows[0].count,
          );
          const activity: Activity[] = rows.map((row) => ({
            id: `${row.tx_hash}:${row.key}`,
            type: row.type,
            txHash: row.tx_hash,
            from: row.from_address,
            to: row.to_address,
            amount:
              row.unit === "eth"
                ? formatEther(BigInt(row.amount))
                : formatUnits(BigInt(row.amount), config.tokenDecimals),
            symbol: row.unit === "eth" ? "ETH" : config.tokenSymbol,
            timestamp: new Date(row.ts).toISOString(),
            blockNumber: Number(row.block_number),
            explorerUrl: `${EXPLORER_URL}/tx/${row.tx_hash}`,
          }));
          return { total, offset, limit, activity };
        } finally {
          client?.release();
        }
      },
    );
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json(
      { error: "Activity history is temporarily unavailable" },
      { status: 503 },
    );
  }
}
