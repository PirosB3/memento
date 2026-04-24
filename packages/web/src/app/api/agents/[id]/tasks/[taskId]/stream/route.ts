import { Client } from "pg";
import {
  channelForTask,
  createLogger,
  getDatabaseUrl,
  prisma,
  type TurnSnapshotState,
} from "@summon/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = createLogger("web:sse:turn-stream");

interface StreamRouteContext {
  params: Promise<{
    id: string;
    taskId: string;
  }>;
}

async function readSnapshot(taskId: string): Promise<TurnSnapshotState> {
  const row = await prisma.turnSnapshot.findUnique({ where: { taskId } });
  if (!row) return { pending: [] };
  const state = row.state as unknown as TurnSnapshotState | null;
  return state ?? { pending: [] };
}

export async function GET(
  request: Request,
  { params }: StreamRouteContext,
): Promise<Response> {
  const { taskId } = await params;

  // Reject unknown task ids up front — otherwise we'd open a pg connection
  // and LISTEN on a channel that never fires, leaking resources on bad URLs.
  const task = await prisma.task.findUnique({ where: { taskId }, select: { taskId: true } });
  if (!task) {
    return new Response(JSON.stringify({ error: "Task not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const channel = channelForTask(taskId);

  // Dedicated pg client per SSE connection: LISTEN binds to a connection, and
  // reusing the Prisma pool here would leak subscriptions across requests.
  const client = new Client({ connectionString: getDatabaseUrl() });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // Stream already closed.
        }
      };

      const cleanup = async () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        client.removeAllListeners("notification");
        try {
          await client.query(`UNLISTEN "${channel}"`);
        } catch {
          // ignore
        }
        try {
          await client.end();
        } catch {
          // ignore
        }
        try {
          controller.close();
        } catch {
          // ignore
        }
      };

      let heartbeat: ReturnType<typeof setInterval> | null = null;

      try {
        await client.connect();

        // Attach the notification listener BEFORE issuing LISTEN so no NOTIFY
        // can arrive unhandled between LISTEN returning and the listener being
        // registered.
        client.on("notification", (msg) => {
          if (msg.channel !== channel) return;
          readSnapshot(taskId)
            .then((state) => send({ type: "snapshot", state }))
            .catch((err) => {
              log.warn(`readSnapshot after NOTIFY failed: ${String(err)}`);
            });
        });
        client.on("error", (err) => {
          log.warn(`pg client error on stream: ${String(err)}`);
          void cleanup();
        });

        await client.query(`LISTEN "${channel}"`);

        // Initial snapshot on connect so late joiners get caught up without
        // waiting for the next publish.
        const initial = await readSnapshot(taskId);
        send({ type: "snapshot", state: initial });

        heartbeat = setInterval(() => send({ type: "heartbeat" }), 25_000);

        request.signal.addEventListener("abort", () => {
          void cleanup();
        });
      } catch (err) {
        log.error(`Failed to initialize SSE stream for task ${taskId}`, err);
        send({ type: "error", message: String(err) });
        await cleanup();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
