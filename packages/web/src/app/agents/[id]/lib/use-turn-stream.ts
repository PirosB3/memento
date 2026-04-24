"use client";

import { useEffect, useState } from "react";
import type { ConversationRow } from "./conversation";

export type PendingOverlayMessage = {
  orderingKey: string;
  role: string;
  message: unknown;
};

// Merge DB-backed conversation rows with the SSE pending overlay, keeping only
// overlay entries whose ordering_key exceeds the max committed key. Returns a
// single ConversationRow[] suitable for feeding directly to ConversationView.
export function mergeOverlay(
  conversations: ConversationRow[],
  pendingOverlay: PendingOverlayMessage[],
): { conversations: ConversationRow[]; isStreaming: boolean } {
  if (pendingOverlay.length === 0) {
    return { conversations, isStreaming: false };
  }
  const maxDbKey = conversations.reduce(
    (acc, row) => (row.orderingKey > acc ? row.orderingKey : acc),
    "",
  );
  const overlayRows = pendingOverlay
    .filter((p) => p.orderingKey > maxDbKey)
    .map((p, idx) => toOverlayRow(p, idx));
  if (overlayRows.length === 0) {
    return { conversations, isStreaming: false };
  }
  return {
    conversations: [...conversations, ...overlayRows],
    isStreaming: true,
  };
}

function toOverlayRow(p: PendingOverlayMessage, idx: number): ConversationRow {
  return {
    // Negative synthetic id — keeps overlay rows from colliding with DB ids,
    // and React remounts the row once the commit surfaces a real DB id.
    id: -(idx + 1),
    role: p.role,
    message: JSON.stringify(p.message),
    timestamp: timestampFromUuidV7(p.orderingKey),
    orderingKey: p.orderingKey,
  };
}

// UUIDv7 format: xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx
// First 48 bits = milliseconds since Unix epoch — 12 hex chars skipping the
// dash at index 8. Extracting the stamp from the key gives a stable timestamp
// per message (fixed at message_start), so the overlay row doesn't jitter as
// tokens stream in.
function timestampFromUuidV7(uuid: string): string {
  const hex = uuid.slice(0, 8) + uuid.slice(9, 13);
  const ms = Number.parseInt(hex, 16);
  if (!Number.isFinite(ms)) return new Date().toISOString();
  return new Date(ms).toISOString();
}

type StreamFrame =
  | { type: "snapshot"; state: { pending: PendingOverlayMessage[] } }
  | { type: "heartbeat" }
  | { type: "error"; message: string };

const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export function useTurnStream(
  agentId: string,
  taskId: string,
): { pendingOverlay: PendingOverlayMessage[] } {
  const [pendingOverlay, setPendingOverlay] = useState<PendingOverlayMessage[]>([]);

  useEffect(() => {
    if (!taskId) return;
    let source: EventSource | null = null;
    let reconnectDelay = RECONNECT_INITIAL_MS;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      source = new EventSource(
        `/api/agents/${agentId}/tasks/${taskId}/stream`,
      );
      source.onmessage = (ev) => {
        reconnectDelay = RECONNECT_INITIAL_MS;
        try {
          const frame = JSON.parse(ev.data) as StreamFrame;
          if (frame.type === "snapshot") {
            setPendingOverlay(frame.state.pending ?? []);
          }
        } catch {
          // ignore malformed frames
        }
      };
      source.onerror = () => {
        source?.close();
        source = null;
        if (cancelled) return;
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [agentId, taskId]);

  return { pendingOverlay };
}
