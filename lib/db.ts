import { Pool, type PoolClient } from "pg";
import type { RuntimeConfig } from "./types";
let connectionPool: Pool | undefined;
let migration: Promise<void> | undefined;
export const defaultConfig: RuntimeConfig = {
  tokenAddress: null,
  startBlock: null,
  tokenSymbol: "HOODBALL",
  tokenName: "Hoodball",
  tokenDecimals: 18,
  vaultAddress: null,
  excludedAddresses: [],
  drawsEnabled: true,
  drawIntervalSeconds: 3600,
  winnersPerDraw: 1,
  minBalance: "0",
  twitterUrl: null,
};
export function pool() {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is not configured");
  if (!connectionPool)
    connectionPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 12,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
    });
  return connectionPool;
}
export async function ensureSchema() {
  if (!migration)
    migration = migrate().catch((error) => {
      migration = undefined;
      throw error;
    });
  await migration;
}
async function migrate() {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(4663, 76201)");
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS hoodball;
      CREATE TABLE IF NOT EXISTS hoodball.runtime_config (
        id integer PRIMARY KEY CHECK (id = 1), config jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS hoodball.config_audit (
        id bigserial PRIMARY KEY, changed_fields text[] NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS hoodball.indexer (
        id integer PRIMARY KEY CHECK (id = 1), indexed_block bigint, indexed_hash text,
        head_block bigint, phase text NOT NULL DEFAULT 'prelaunch', error text,
        last_synced_at timestamptz, halted boolean NOT NULL DEFAULT false,
        total_supply numeric(78,0), pending_verify boolean NOT NULL DEFAULT false
      );
      CREATE TABLE IF NOT EXISTS hoodball.holders (
        address text PRIMARY KEY, balance numeric(78,0) NOT NULL CHECK (balance >= 0),
        is_contract boolean NOT NULL, updated_block bigint NOT NULL,
        first_seen_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS holders_rank_idx ON hoodball.holders(balance DESC) WHERE balance > 0;
      CREATE TABLE IF NOT EXISTS hoodball.pools (
        address text PRIMARY KEY, source text NOT NULL, pair_token text, fee integer,
        discovered_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS hoodball.transfers (
        tx_hash text NOT NULL, log_index integer NOT NULL, block_number bigint NOT NULL,
        block_hash text NOT NULL, from_address text NOT NULL, to_address text NOT NULL,
        amount numeric(78,0) NOT NULL CHECK (amount >= 0), timestamp timestamptz NOT NULL,
        PRIMARY KEY(tx_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS transfers_order_idx ON hoodball.transfers(block_number DESC, log_index DESC);
      CREATE TABLE IF NOT EXISTS hoodball.tx_classifications (
        tx_hash text PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('transfer','swap')), pool_address text
      );
      CREATE TABLE IF NOT EXISTS hoodball.price_points (
        ts timestamptz PRIMARY KEY, price_usd numeric, market_cap_usd numeric, source text NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hoodball.draws (
        id text PRIMARY KEY,
        cycle_id bigint NOT NULL UNIQUE,
        scheduled_at timestamptz NOT NULL,
        executed_at timestamptz,
        snapshot_block bigint,
        status text NOT NULL CHECK (status IN ('scheduled','paid','rolled_over','skipped','review')),
        pot_wei numeric(78,0) NOT NULL DEFAULT 0,
        gas_reserve_wei numeric(78,0) NOT NULL DEFAULT 0,
        eligible_count integer NOT NULL DEFAULT 0,
        eligible_balance numeric(78,0) NOT NULL DEFAULT 0,
        seed_hash text,
        seed text,
        revealed_at timestamptz,
        skip_reason text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS draws_history_idx ON hoodball.draws(scheduled_at DESC, cycle_id DESC);
      CREATE TABLE IF NOT EXISTS hoodball.draw_payouts (
        id text PRIMARY KEY,
        draw_id text NOT NULL REFERENCES hoodball.draws(id) ON DELETE CASCADE,
        recipient text NOT NULL,
        amount_wei numeric(78,0) NOT NULL CHECK (amount_wei > 0),
        balance_wei numeric(78,0) NOT NULL,
        odds_bps integer NOT NULL,
        status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','signed','submitted','confirmed','failed','review')),
        nonce bigint, tx_hash text UNIQUE, raw_tx text, block_number bigint, reason text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        confirmed_at timestamptz,
        UNIQUE(draw_id, recipient)
      );
      CREATE INDEX IF NOT EXISTS draw_payouts_queue_idx ON hoodball.draw_payouts(status, created_at);
      CREATE INDEX IF NOT EXISTS draw_payouts_draw_idx ON hoodball.draw_payouts(draw_id);
      CREATE TABLE IF NOT EXISTS hoodball.treasury_ops (
        id text PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('sweep','claim','unwrap')),
        status text NOT NULL CHECK (status IN ('queued','signed','submitted','confirmed','failed','review')),
        amount_in numeric(78,0), amount_out numeric(78,0), expected_out numeric(78,0),
        nonce bigint, raw_tx text, tx_hash text UNIQUE, block_number bigint, reason text,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS treasury_ops_queue_idx ON hoodball.treasury_ops(status, created_at);
      CREATE INDEX IF NOT EXISTS treasury_ops_history_idx ON hoodball.treasury_ops(created_at DESC);
      CREATE TABLE IF NOT EXISTS hoodball.treasury_income (
        id text PRIMARY KEY, source text NOT NULL CHECK (source IN ('escrow_claim','escrow_push','sweep')),
        tx_hash text NOT NULL, log_index integer NOT NULL, amount_wei numeric(78,0) NOT NULL, token_address text,
        block_number bigint NOT NULL, ts timestamptz NOT NULL, UNIQUE(tx_hash, log_index)
      );
      CREATE TABLE IF NOT EXISTS hoodball.treasury_cursor (
        id integer PRIMARY KEY CHECK (id = 1), block bigint NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS hoodball.treasury_state (
        id integer PRIMARY KEY CHECK (id = 1), state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      ALTER TABLE hoodball.treasury_ops DROP CONSTRAINT IF EXISTS treasury_ops_kind_check;
      ALTER TABLE hoodball.treasury_ops ADD CONSTRAINT treasury_ops_kind_check CHECK (kind IN ('sweep','claim','unwrap'));
    `);
    await client.query(
      "INSERT INTO hoodball.runtime_config(id,config) VALUES(1,$1) ON CONFLICT DO NOTHING",
      [JSON.stringify(defaultConfig)],
    );
    await client.query(
      "INSERT INTO hoodball.indexer(id) VALUES(1) ON CONFLICT DO NOTHING",
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function readConfig(client?: PoolClient): Promise<RuntimeConfig> {
  const result = await (client ?? pool()).query(
    "SELECT config FROM hoodball.runtime_config WHERE id = 1",
  );
  return { ...defaultConfig, ...result.rows[0].config };
}
