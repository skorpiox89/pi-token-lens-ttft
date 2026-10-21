import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-token-lens-ttft
 *
 * Records the time-to-first-token of every assistant request as a durable
 * session entry (`customType: "token-lens.ttft"`) so that TokenLens'
 * lens-agent collector can attach it to the matching usage row.
 *
 * pi does not persist TTFT itself (it is only available while streaming), and
 * display-only extensions such as pi-token-speed keep the value in memory.
 * Writing a custom entry puts the measurement into the same session JSONL the
 * collector already tails; no sidecar file or IPC is involved.
 *
 * The join key is `assistant_ts`: the nested assistant message timestamp
 * (unix millis, request start), which the collector stores as `created_at`
 * for pi records. `ttft_ms` is measured from that timestamp to the first
 * stream event, so queueing before the message object is created is not
 * included (it is request latency, not prompt handling time).
 */

const TTFT_CUSTOM_TYPE = "token-lens.ttft";

const STREAM_START_EVENTS = new Set([
  "text_start",
  "thinking_start",
  "toolcall_start",
]);

interface PendingTTFT {
  assistantTs: number;
  ttftMs: number;
  responseId?: string;
}

export default (pi: ExtensionAPI) => {
  let pending: PendingTTFT | null = null;

  pi.on("message_update", (event) => {
    if (pending) return;
    if (!STREAM_START_EVENTS.has(event.assistantMessageEvent.type)) return;
    const msg = event.message;
    if (!msg || msg.role !== "assistant" || !msg.timestamp) return;
    pending = {
      assistantTs: msg.timestamp,
      ttftMs: Math.max(Date.now() - msg.timestamp, 0),
      responseId: msg.responseId,
    };
  });

  // turn_end fires once per assistant message after it is persisted, so the
  // custom entry is appended after (and parented to) the assistant entry
  // instead of landing between it and its parent.
  pi.on("turn_end", (event) => {
    const msg = event.message;
    if (!pending || !msg || msg.role !== "assistant") return;
    if (msg.timestamp !== pending.assistantTs) {
      // A different request finished first; drop the stale capture.
      pending = null;
      return;
    }
    pi.appendEntry(TTFT_CUSTOM_TYPE, {
      assistant_ts: pending.assistantTs,
      message_entry_id: event.messageEntryId,
      response_id: pending.responseId ?? msg.responseId ?? "",
      ttft_ms: pending.ttftMs,
      model: msg.model,
      provider: msg.provider,
    });
    pending = null;
  });

  // A new user prompt starts a new request; drop a capture whose stream was
  // aborted before message_end so it cannot leak into the next response.
  pi.on("message_start", (event) => {
    if (event.message?.role === "user") {
      pending = null;
    }
  });
};
