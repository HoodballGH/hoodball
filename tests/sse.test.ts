import { test } from "node:test";
import assert from "node:assert/strict";
import {
  refreshSnapshot,
  subscribeSnapshots,
  snapshotEventPayload,
  getSnapshot,
} from "../lib/snapshot";
import { GET } from "../app/api/events/route";
import type { Snapshot } from "../lib/types";
delete process.env.DATABASE_URL;
process.env.HOODBALL_WORKER_ENABLED = "false";
test("a throwing SSE listener cannot break fanout to the other listeners or reject the refresh", async () => {
  const seen: string[] = [];
  const unsubscribeBad = subscribeSnapshots(() => {
    throw new Error("listener exploded");
  });
  const unsubscribeGood = subscribeSnapshots((snapshot) => {
    seen.push(snapshot.version);
  });
  try {
    await refreshSnapshot();
    await refreshSnapshot();
  } finally {
    unsubscribeBad();
    unsubscribeGood();
  }
  assert(
    seen.length >= 1,
    "a healthy listener registered after a throwing one must still receive snapshots",
  );
});
test("the SSE payload is serialized once per snapshot, not once per connected client", () => {
  let reads = 0;
  const snapshot = {
    get version() {
      reads++;
      return "abc";
    },
  } as unknown as Snapshot;
  const first = snapshotEventPayload(snapshot);
  const second = snapshotEventPayload(snapshot);
  assert.equal(first, second);
  assert.equal(
    reads,
    1,
    "repeated fanout of the same snapshot must reuse the cached JSON",
  );
  assert(first.startsWith("event: snapshot\ndata: "));
  assert(first.endsWith("\n\n"));
});
test("a slow SSE consumer is disconnected instead of buffering without bound", async () => {
  const controller = new AbortController();
  const response = await GET(
    new Request("http://127.0.0.1/api/events", { signal: controller.signal }),
  );
  const reader = response.body!.getReader();
  for (let i = 0; i < 10; i++) await refreshSnapshot();
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  for (;;) {
    const next = await Promise.race([
      reader.read(),
      new Promise<{ done: boolean; value?: Uint8Array }>((resolve) =>
        setTimeout(() => resolve({ done: false, value: undefined }), 2000),
      ),
    ]);
    if (next.done) break;
    assert(
      next.value,
      "a slow stream must terminate rather than stall with an unbounded buffer",
    );
    chunks.push(decoder.decode(next.value));
    assert(
      chunks.length <= 6,
      "the queue must stay bounded by the stream high-water mark",
    );
  }
  controller.abort();
  assert(
    chunks[0].startsWith("retry: 5000\nevent: snapshot\ndata: "),
    "the first frame must carry a full snapshot immediately",
  );
  await refreshSnapshot();
});
test("aborting an SSE request removes the listener and never throws out of the abort handler", async () => {
  assert((await getSnapshot()).version.length > 0);
  const controller = new AbortController();
  const response = await GET(
    new Request("http://127.0.0.1/api/events", { signal: controller.signal }),
  );
  const reader = response.body!.getReader();
  await reader.read();
  controller.abort();
  await refreshSnapshot();
  await reader.cancel();
  await refreshSnapshot();
});
