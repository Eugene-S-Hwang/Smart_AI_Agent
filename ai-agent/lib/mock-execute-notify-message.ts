import type { DecisionTrace } from "./types";

/**
 * Mock assistant reply shown in the Session chat after execute_notify (nothing runs for real).
 * Read-only / lookup intents get a plausible fabricated summary; everything else gets a generic “done” line.
 */
export function mockAssistantMessageForExecuteNotify(
  trace: DecisionTrace,
): string {
  const signals = trace.inputs.proposedAction.matched_signals ?? [];
  const tz =
    trace.inputs.userState.timezone ?? trace.inputs.userState.primary_calendar ?? "your local timezone";

  const isReadonlyLookup =
    signals.includes("read_calendar_only") ||
    signals.includes("information_lookup");

  if (isReadonlyLookup) {
    return (
      `Here’s what I found (mock lookup — not a real inbox or calendar): today — 9:30 Team sync, ` +
      `12:00 Lunch hold, 4:00 1:1 with Jordan (${tz}). Unread mail: I’d show ~12 threads including 3 VIP — but this is placeholder text for the demo. Want me to open any of these?`
    );
  }

  return (
    `Done — I completed that action on your behalf (mock only; nothing was actually sent, paid, or booked).`
  );
}
