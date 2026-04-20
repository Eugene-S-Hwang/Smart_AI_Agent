import type { ChatMessage, DecisionTrace } from "./types";

export const CHAT_SESSION_STORAGE_KEY =
  "execution-decision-layer-chat-v1";

export type VerdictSnapshot = {
  id: string;
  ts: number;
  decision: string;
  rationale: string;
  clarifying_question?: string;
  failure?: DecisionTrace["failure"];
};

export type ChatSessionEvent =
  | { type: "message"; message: ChatMessage }
  | { type: "verdict"; verdict: VerdictSnapshot };

export type PersistedChatSession = {
  v: 2;
  scenarioId: string;
  timeline: ChatSessionEvent[];
  /** Last user line when it is only in the composer (not yet shown as a chat bubble). */
  composerDraft?: string;
  userState: string;
  llmInstructions: string;
  simulateFailure: string;
};

/**
 * Puts the trailing user message into the draft slot so it can appear in the composer
 * without duplicating it as an already-sent bubble in the thread.
 */
export function splitTrailingUserDraft(history: ChatMessage[]): {
  committed: ChatMessage[];
  trailingUserDraft: string;
} {
  if (history.length === 0) {
    return { committed: [], trailingUserDraft: "" };
  }
  const last = history[history.length - 1]!;
  if (last.role === "user") {
    return {
      committed: history.slice(0, -1),
      trailingUserDraft: last.content,
    };
  }
  return { committed: [...history], trailingUserDraft: "" };
}

export function messagesFromTimeline(events: ChatSessionEvent[]): ChatMessage[] {
  return events
    .filter((e): e is Extract<ChatSessionEvent, { type: "message" }> => e.type === "message")
    .map((e) => e.message);
}

/** Used when re-running the pipeline so the latest verdict card is replaced, not duplicated. */
export function stripLastVerdictIfPresent(
  events: ChatSessionEvent[],
): ChatSessionEvent[] {
  if (events.length === 0) return events;
  const last = events[events.length - 1];
  if (last.type === "verdict") return events.slice(0, -1);
  return events;
}

/**
 * Drops the latest decision round: optional assistant clarification bubble right after a verdict,
 * then the verdict card (for “re-run decision” without stacking duplicates).
 */
export function stripLastDecisionRound(
  events: ChatSessionEvent[],
): ChatSessionEvent[] {
  const out = [...events];
  const n = out.length;
  if (n >= 2) {
    const last = out[n - 1];
    const prev = out[n - 2];
    if (
      last.type === "message" &&
      last.message.role === "assistant" &&
      prev.type === "verdict"
    ) {
      out.pop();
    }
  }
  if (out.length && out[out.length - 1].type === "verdict") {
    out.pop();
  }
  return out;
}

/** Removes only the verdict card so the thread can continue; keeps chat messages (e.g. clarification). */
export function stripTrailingVerdictCard(
  events: ChatSessionEvent[],
): ChatSessionEvent[] {
  if (events.length === 0) return events;
  const last = events[events.length - 1];
  if (last.type === "verdict") {
    return events.slice(0, -1);
  }
  if (events.length >= 2) {
    const prev = events[events.length - 2];
    if (
      last.type === "message" &&
      last.message.role === "assistant" &&
      prev.type === "verdict"
    ) {
      const out = [...events];
      out.splice(events.length - 2, 1);
      return out;
    }
  }
  return events;
}

export function timelineFromScenarioMessages(
  messages: ChatMessage[],
): ChatSessionEvent[] {
  return messages.map((m) => ({ type: "message" as const, message: m }));
}

export function verdictFromTrace(trace: DecisionTrace): VerdictSnapshot {
  return {
    id:
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `v-${Date.now()}`,
    ts: Date.now(),
    decision: trace.parsed.decision,
    rationale: trace.parsed.rationale,
    clarifying_question: trace.parsed.clarifying_question,
    failure: trace.failure,
  };
}
