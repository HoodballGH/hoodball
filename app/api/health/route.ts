import { getSnapshot } from "@/lib/snapshot";
export const dynamic = "force-dynamic";
export async function GET() {
  const snapshot = await getSnapshot();
  return Response.json(
    {
      service: "hoodball",
      status: snapshot.chain.status,
      chainId: snapshot.chain.id,
      indexedBlock: snapshot.chain.indexedBlock,
      headBlock: snapshot.chain.headBlock,
      lastSyncedAt: snapshot.chain.lastSyncedAt,
      drawsEnabled: snapshot.config.drawsEnabled,
      drawGate: snapshot.draws.gate,
      nextDrawAt: snapshot.draws.nextDrawAt,
    },
    {
      status: snapshot.chain.status === "error" ? 503 : 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
