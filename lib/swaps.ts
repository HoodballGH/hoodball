import { pool, readConfig } from "./db";
import { rpc } from "./rpc";
import { swapPoolCandidates, poolContainsToken, type ReceiptLog } from "./swap-detection";
import { recordPools } from "./pools";
let active = false;
export async function refreshSwapClassifications() {
  if (active) return;
  active = true;
  let client;
  let locked = false;
  try {
    client = await pool().connect();
    locked = (await client.query("SELECT pg_try_advisory_lock(4663,76203) AS locked")).rows[0].locked;
    if (!locked) return;
    const config = await readConfig(client);
    if (!config.tokenAddress) return;
    const candidates = await client.query(`SELECT DISTINCT t.tx_hash,t.block_hash,t.block_number FROM hoodball.transfers t
      LEFT JOIN hoodball.tx_classifications c ON c.tx_hash=t.tx_hash WHERE c.tx_hash IS NULL ORDER BY t.block_number DESC LIMIT 20`);
    for (let offset = 0; offset < candidates.rows.length; offset += 4) {
      const results = await Promise.all(candidates.rows.slice(offset, offset + 4).map(async row => {
        try {
          const receipt = await rpc<{ blockHash: string; logs: ReceiptLog[] } | null>("eth_getTransactionReceipt", [row.tx_hash]);
          if (!receipt || receipt.blockHash.toLowerCase() !== row.block_hash.toLowerCase()) return null;
          for (const address of swapPoolCandidates(receipt.logs).slice(0, 8)) {
            try {
              const [a, b] = await Promise.all([rpc<string>("eth_call", [{ to: address, data: "0x0dfe1681" }, "latest"]), rpc<string>("eth_call", [{ to: address, data: "0xd21220a7" }, "latest"])]);
              if (poolContainsToken(config.tokenAddress!, a, b)) return { tx_hash: row.tx_hash, kind: "swap", pool_address: address };
            } catch { continue; }
          }
          return { tx_hash: row.tx_hash, kind: "transfer", pool_address: null };
        } catch { return null; }
      }));
      const batch = results.filter(result => result !== null);
      await recordPools(client, batch.filter(row => row.pool_address).map(row => ({ address: row.pool_address!, source: "swap-log", pairToken: null, fee: null })));
      if (batch.length) await client.query(`INSERT INTO hoodball.tx_classifications(tx_hash,kind,pool_address)
        SELECT tx_hash,kind,pool_address FROM jsonb_to_recordset($1::jsonb) AS x(tx_hash text,kind text,pool_address text)
        ON CONFLICT(tx_hash) DO NOTHING`, [JSON.stringify(batch)]);
    }
  } finally {
    try {
      if (client) {
        try { if (locked) await client.query("SELECT pg_advisory_unlock(4663,76203)"); }
        finally { client.release(); }
      }
    } finally { active = false; }
  }
}
