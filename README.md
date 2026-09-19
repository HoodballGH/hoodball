<p align="center">
  <img src="public/brand/banner.png" alt="Hoodball" width="100%">
</p>

# Hoodball

**The open-source engine behind [hoodball.net](https://hoodball.net): an automated, balance-weighted lottery for $HOODBALL holders on Robinhood Chain.**

This repository is published so anyone can check that Hoodball is fair. The code here is the code that runs the site: the indexer that counts holders, the rule that decides who is eligible, the draw that picks winners, and the keeper that moves the ETH. Nothing in it is hidden and every draw can be replayed from public data.

- Site: https://hoodball.net · X: [@PlayHoodball](https://x.com/PlayHoodball)
- Chain: Robinhood Chain (4663), native ETH · Explorer: https://robinhoodchain.blockscout.com
- Launchpad: Pons V2 (creator fees fund the pot)

## Why it is fair

- **Pro rata, nothing else.** Your chance of winning a draw is exactly `your balance / total eligible balance`. No tiers, no boosts, no whitelist. Check yours at `https://hoodball.net/api/odds?address=0xYOU`.
- **Pools and contracts cannot win.** The Pons bonding curve, every Uniswap V3 pool for the token, any address that emits swap logs, any contract account, the vault, the token contract, the zero and burn addresses are excluded in one place: [`lib/eligibility.ts`](lib/eligibility.ts) and [`lib/pools.ts`](lib/pools.ts).
- **Commit, then reveal.** Every draw stores `keccak256(seed)` before winners are picked and publishes the seed once the payout settles. The selection in [`lib/draw-selection.ts`](lib/draw-selection.ts) is a pure function of the seed and the holder snapshot, so you can replay any draw and get the same winner.
- **Real balances, real receipts.** Holder balances are rebuilt from `Transfer` logs and verified against `balanceOf` and `totalSupply`; a mismatch halts draws instead of guessing. A payout counts as paid only after 12 confirmations and an exact receipt match.
- **Whole pot, every draw.** The pot is the vault's ETH minus a small gas reserve. If it is below the minimum it rolls over, and that is recorded too.

## Replay a draw yourself

```bash
curl -s 'https://hoodball.net/api/draws?limit=1' | jq '.items[0] | {cycleId, snapshotBlock, seedHash, seed, payouts}'
```

Rebuild the eligible set at `snapshotBlock` (or take it from `/api/holders`), then run `selectWinners(seed, holders, winnersPerDraw)` from `lib/draw-selection.ts`. `keccak256(seed)` must equal `seedHash`, and the output must equal the recorded recipients.

---

An automated, balance-weighted lottery for a token launched on Pons V2 on **Robinhood Chain** (chain id 4663).

Creator fees from the Pons launch are swept and claimed into the dev wallet (the **vault**). Every draw the
accumulated ETH pot is sent to a holder picked at random, weighted by balance: twice the balance wins twice as
often. Liquidity pools, contracts, the vault, the token contract and burn addresses are never eligible.

Everything the site shows is read from the chain and the database. Before a token is configured the site shows
an empty, honest pre-launch state — no placeholder winners, no fabricated pot.

## How it works

1. **Indexer.** Every `Transfer` log for the token is replayed from its deployment block into
   `hoodball.holders`. Balances are verified against `balanceOf` at the indexed block and the sum is checked
   against `totalSupply`; a mismatch or a reorg halts the indexer and pauses draws.
2. **Treasury keeper.** Sweeps the Pons curve's creator share into the fee escrow when the vault is the creator
   fee recipient, then `claim()`s the escrow into the vault. Every claim and sweep is also scanned out of chain
   logs so the income ledger is complete even for fees pushed without a claim.
3. **Draws.** On each wall-clock boundary of `drawIntervalSeconds` (UTC epoch multiples), the engine takes the
   eligible-holder set at the indexer's confirmed block, computes
   `pot = vaultEthBalance − HOODBALL_GAS_RESERVE_WEI`, and picks `winnersPerDraw` winners with BigInt weighted
   sampling without replacement from a fresh 32-byte server seed. The pot is split equally and paid as native
   ETH transfers (21 000 gas).
4. **Verification.** `seedHash = keccak256(seed)` is published with the draw; the seed itself is revealed once
   every payout has confirmed or failed, so anyone can replay the selection.

### Draw states

| Status        | Meaning                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `scheduled`   | Winners are chosen and payouts are signed/in flight                      |
| `paid`        | Every payout confirmed with an exact receipt                             |
| `rolled_over` | Pot was below `HOODBALL_MIN_POT_WEI`; it carries into the next draw      |
| `skipped`     | No eligible holders at the snapshot block                                |
| `review`      | A payout failed or did not match its exact receipt; automation is paused |

### Draw gate

`draws.gate` in the snapshot says exactly why draws are or are not paying, in priority order:

`no_token` → `indexer_not_live` → `money_disabled` → `no_vault_key` → `vault_mismatch` →
`unsupported_quote` → `paused` → `ok`

`unsupported_quote` means the Pons launch is quoted in an ERC-20 rather than ETH. Hoodball pays native ETH only,
so draws stop rather than pay something else.

## Run

```bash
npm install
createdb hoodball_dev
cat > .env.local <<'ENV'
DATABASE_URL=postgresql://you@127.0.0.1:5432/hoodball_dev
ROBINHOOD_RPC_URL=https://your-quicknode-endpoint
HOODBALL_ADMIN_TOKEN=<32+ random characters>
ENV
npm run dev            # custom server: Next.js + the single elected worker
```

Fixture data (never touches a remote database, never sends a transaction):

```bash
HOODBALL_ALLOW_FIXTURE=true npm run seed:fixture
HOODBALL_WORKER_ENABLED=false npm run dev
```

`HOODBALL_WORKER_ENABLED=false` puts the process in read-only mode: no indexing, no RPC writes, no price reads.

Checks:

```bash
npm run typecheck
npm run lint
npm test
createdb hoodball_itest
HOODBALL_TEST_DATABASE_URL=postgresql://you@127.0.0.1:5432/hoodball_itest npm run test:integration
npm run build
```

## Configure

All configuration is runtime state in `hoodball.runtime_config`, changed through
`POST /api/config` with `Authorization: Bearer $HOODBALL_ADMIN_TOKEN`. **No redeploy is ever needed to set or
change the contract address** — every open browser picks the change up over SSE.

```bash
npm run configure -- https://hoodball.net docs/launch-config.json   # interval, winners, minBalance, X link
npm run set-contract -- 0xTOKEN https://hoodball.net                # token only
npm run go-live -- 0xTOKEN https://hoodball.net                     # token + wait for live + print the gate
```

| Field                                         | Type                    | Default                        | Notes                                                             |
| --------------------------------------------- | ----------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `tokenAddress`                                | address \| null         | `null`                         | Immutable once set; `startBlock` is discovered automatically      |
| `startBlock`                                  | number \| null          | `null`                         | Optional; must not be later than the first `Transfer`             |
| `tokenSymbol` / `tokenName` / `tokenDecimals` | —                       | `HOODBALL` / `Hoodball` / `18` | Overwritten from on-chain metadata when the token is set          |
| `vaultAddress`                                | address \| null         | `null`                         | Dev wallet = Pons `creatorFeeRecipient` = payout signer           |
| `excludedAddresses`                           | address[]               | `[]`                           | Extra addresses that can never win                                |
| `drawsEnabled`                                | boolean                 | `true`                         | Pause/resume; the only field changeable while payouts are pending |
| `drawIntervalSeconds`                         | number                  | `3600`                         | 300 – 604800, aligned to UTC boundaries                           |
| `winnersPerDraw`                              | number                  | `1`                            | 1 – 10, pot split equally                                         |
| `minBalance`                                  | decimal string          | `"0"`                          | Minimum token balance to be eligible                              |
| `twitterUrl`                                  | https://x.com/… \| null | `null`                         | `null` renders a disabled "X · soon" pill                         |

Setting the token verifies: chain id 4663, the contract is deployed, it has 12 confirmations, its first
`Transfer` is at or after `startBlock`, and its ERC-20 metadata is readable.

## Money safety

- A transaction is only ever signed when **all** of these hold: `MONEY_ENABLED=true`, a well-formed
  `HOODBALL_VAULT_PRIVATE_KEY` whose address equals `vaultAddress`, the indexer is `live`, healthy and not
  halted, and nothing is awaiting operator review. The treasury keeper additionally requires
  `HOODBALL_TREASURY_ENABLED=true`.
- Payout intents are written to `hoodball.draw_payouts`, **signed**, and the exact raw bytes and transaction
  hash are persisted **before** broadcast. A transaction is never re-signed: an ambiguous broadcast rebroadcasts
  the retained bytes, so the same nonce can never produce two different payloads.
- Settlement requires 12 confirmations, a canonical block hash, receipt status 1, `to == recipient`,
  `from == vault` and `value == amount_wei`. Anything else becomes `review` and stops further draws.
- A consumed nonce, a reverted transaction or a mismatched receipt pauses automation instead of retrying.
- Draws and the treasury share one Postgres advisory lock on the vault address, so only one of them ever holds
  the vault nonce.
- The private key is only ever read in the server process; no secret reaches the browser.

## API

All read endpoints are public JSON, `Cache-Control: no-store`.

| Endpoint                                         | Returns                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| `GET /api/snapshot`                              | The whole `Snapshot` (`lib/types.ts`)                                         |
| `GET /api/events`                                | SSE of the same payload, version-gated, 30 s keepalive                        |
| `GET /api/health`                                | `status`, blocks, `drawsEnabled`, `drawGate`, `nextDrawAt` (503 when errored) |
| `GET /api/draws?offset=0&limit=25`               | `{ total, offset, limit, items: DrawRecord[] }`, newest first                 |
| `GET /api/holders?offset&limit` / `?address=0x…` | `Holder` rows ranked by balance                                               |
| `GET /api/odds?address=0x…`                      | balance, eligibility, `odds`, `oneIn`, `nextDrawAt`                           |
| `GET /api/activity?offset&limit`                 | transfers, swaps, mints, burns and confirmed payouts                          |
| `GET /api/treasury?offset&limit`                 | sweep/claim ops and the income ledger                                         |
| `GET /api/market/history?hours=24`               | downsampled price points                                                      |
| `GET /api/config`                                | the current `RuntimeConfig`                                                   |
| `POST /api/config`                               | bearer-authenticated configuration update                                     |

Field notes for consumers: `Holder.sharePct` is the share of **all** indexed balance (0–100), while
`Payout.oddsPct` is the winner's share of the **eligible** balance at draw time. `Jackpot.potWei` is the live
vault balance minus the gas reserve, so it is the pot the _next_ draw would pay; `DrawRecord.potWei` is what a
past draw actually paid. `DrawRecord.seed` is `null` until every payout settles.

## Env

| Variable                             | Required       | Default                        | Purpose                                                   |
| ------------------------------------ | -------------- | ------------------------------ | --------------------------------------------------------- |
| `DATABASE_URL`                       | yes            | —                              | Postgres connection string                                |
| `ROBINHOOD_RPC_URL`                  | yes            | public RPC                     | QuickNode endpoint for chain 4663                         |
| `HOODBALL_ADMIN_TOKEN`               | yes            | —                              | Bearer token for `POST /api/config` (≥ 32 chars)          |
| `MONEY_ENABLED`                      | for payouts    | `false`                        | Master switch for every signed transaction                |
| `HOODBALL_VAULT_PRIVATE_KEY`         | for payouts    | —                              | `0x` + 64 hex; must equal `vaultAddress`                  |
| `HOODBALL_TREASURY_ENABLED`          | for fee claims | `false`                        | Enables sweep/claim automation                            |
| `SITE_URL`                           | recommended    | —                              | Canonical origin, used by the scripts and metadata        |
| `HOODBALL_WORKER_ENABLED`            | no             | `true`                         | `false` = read-only instance (no indexing, no RPC writes) |
| `HOODBALL_GAS_RESERVE_WEI`           | no             | `20000000000000000` (0.02 ETH) | Held back from the pot for gas                            |
| `HOODBALL_MIN_POT_WEI`               | no             | `500000000000000` (0.0005 ETH) | Below this a draw rolls over                              |
| `HOODBALL_MIN_CLAIM_WEI`             | no             | `2000000000000000`             | Minimum escrow balance worth claiming                     |
| `HOODBALL_MIN_SWEEP_WEI`             | no             | `2000000000000000`             | Minimum curve fee balance worth sweeping                  |
| `HOODBALL_MAX_GAS_PRICE_WEI`         | no             | `100000000000`                 | Refuse to sign above this gas price                       |
| `HOODBALL_MIN_ETH_WEI`               | no             | `1000000000000000`             | Vault ETH floor kept for future fees                      |
| `HOODBALL_TREASURY_INTERVAL_SECONDS` | no             | `30`                           | Treasury keeper throttle                                  |
| `HOODBALL_MARKET_INTERVAL_SECONDS`   | no             | `10`                           | Market read throttle                                      |
| `HOODBALL_ETH_PRICE_MAX_AGE_SECONDS` | no             | `3600`                         | Max Chainlink ETH/USD staleness                           |
| `HOODBALL_RPC_CONCURRENCY`           | no             | `6`                            | In-flight RPC requests                                    |
| `HOODBALL_RPC_BATCH_SIZE`            | no             | `25`                           | JSON-RPC batch size                                       |
| `HOODBALL_ALLOW_FIXTURE`             | no             | —                              | Must be `true` for `npm run seed:fixture`                 |
| `HOODBALL_INDEX_WINDOW`              | no             | `10000`                        | Max `eth_getLogs` span per request (QuickNode caps at 10,000; hard-capped) |
| `HOODBALL_INCOME_WINDOW`             | no             | `10000`                        | Treasury income scan span per request (hard-capped at 10,000) |
| `HOODBALL_RPC_STATE_WINDOW`          | no             | `3000`                         | Blocks behind head within which balances are verified on chain |
| `HOODBALL_INDEX_TICK_BUDGET_MS`      | no             | `40000`                        | Max time one worker tick spends indexing                  |
| `HOODBALL_RPC_MIN_SPACING_MS`        | no             | `25`                           | Minimum spacing between RPC requests                      |
| `HOODBALL_RPC_BATCH`                 | no             | `true`                         | `false` disables JSON-RPC batching                        |

## Verification

```bash
npm run lint && npm run typecheck && npm test && npm run build
HOODBALL_TEST_DATABASE_URL=postgresql://you@127.0.0.1:5432/hoodball_itest npm run test:integration
curl -s https://hoodball.net/api/health | jq
curl -s https://hoodball.net/api/snapshot | jq '.draws, .jackpot, .stats'
curl -s 'https://hoodball.net/api/odds?address=0xYOURWALLET' | jq
```

The integration test runs the whole engine against a disposable Postgres and a mocked RPC: 300 holders
including 5 contracts and 1 discovered Uniswap V3 pool, a rolled-over draw, a paid draw verified against an
exact receipt, the seed reveal, duplicate-cycle protection, the money gate and pause/resume.

To replay a draw yourself: take `seed` and `snapshotBlock` from `/api/draws`, rebuild the eligible set at that
block, and run `selectWinners` from `lib/draw-selection.ts`.

## Launch checklist (operator)

1. On the production host, set `MONEY_ENABLED=true`, `HOODBALL_VAULT_PRIVATE_KEY=0x…` and
   `HOODBALL_TREASURY_ENABLED=true` (plus `DATABASE_URL`, `ROBINHOOD_RPC_URL`, `HOODBALL_ADMIN_TOKEN`,
   `SITE_URL`).
2. Fund the vault with a little ETH for gas (the gas reserve defaults to 0.02 ETH and is never paid out).
3. The vault address is derived from `HOODBALL_VAULT_PRIVATE_KEY` automatically on the next worker tick
   (the signer is the vault). `npm run configure -- https://hoodball.net docs/launch-config.json` is only
   needed to change the interval, winners per draw, minimum balance, exclusions or the X link.
4. Launch the token on Pons with the vault (dev wallet) as the creator fee recipient.
5. Flip it live, no redeploy: `npm run go-live -- 0xTOKEN https://hoodball.net`.
6. Confirm `draws.gate === "ok"` and watch the countdown; the first draw runs as soon as the index is live
   (rolled over if the pot is still empty), then every interval boundary.

Escrow claims arrive as ETH; when the escrow pushes WETH instead, the keeper unwraps it (`unwrap` op) so the
whole balance stays payable as native ETH.

Pause at any time with `POST /api/config {"drawsEnabled": false}` — pending payouts still settle, and no new
draw is started until you resume.
