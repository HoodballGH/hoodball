import {
  getSnapshot,
  snapshotEventPayload,
  subscribeSnapshots,
} from "@/lib/snapshot";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const initial = await getSnapshot();
  const encoder = new TextEncoder();
  let cleanup: (close?: boolean) => void = () => {};
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let closed = false;
        let unsubscribe = () => {};
        const onAbort = () => cleanup();
        const heartbeat = setInterval(() => send(": heartbeat\n\n"), 15000);
        cleanup = (close = true) => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          request.signal.removeEventListener("abort", onAbort);
          if (close)
            try {
              controller.close();
            } catch {
              /* already closed by the consumer */
            }
        };
        const send = (value: string) => {
          if (closed) return;
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            cleanup();
            return;
          }
          try {
            controller.enqueue(encoder.encode(value));
          } catch {
            cleanup(false);
          }
        };
        send(`retry: 5000\n${snapshotEventPayload(initial)}`);
        unsubscribe = subscribeSnapshots((snapshot) =>
          send(snapshotEventPayload(snapshot)),
        );
        request.signal.addEventListener("abort", onAbort, { once: true });
        if (request.signal.aborted) cleanup();
      },
      cancel() {
        cleanup(false);
      },
    },
    { highWaterMark: 4 },
  );
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
