import type { ChatMessage, DecisionTrace } from "./types";

function assistantTranscript(messages: ChatMessage[]): string {
  const parts = messages.filter((m) => m.role === "assistant").map((m) => m.content);
  return parts.length ? parts.join("\n\n---\n\n") : "(none yet)";
}

const SYSTEM = `You write the assistant's NEXT chat message after a mock "execute_notify" step.

Rules:
- All calendar events, emails, threads, and inbox summaries are **invented simulation** — there is no real inbox or calendar connected. Say so briefly once (e.g. "simulated lookup" or "demo data").
- Answer what the user actually asked in the latest turn, using full transcript context (follow-ups like "the first VIP thread" refer to earlier discussion).
- Match userState timezone / VIP hints when naming times or contacts.
- Be concise but concrete: use plausible meeting titles, email From/Subject lines, or short quoted body text when they asked to read mail.
- If prior assistant messages already gave a long calendar/inbox summary, **do not** paste the same block again — give a delta, a specific drill-down, or the email body they asked for.
- No JSON, no meta commentary about APIs or policy. Plain user-facing prose.`;

export function buildExecuteNotifyReplyPrompts(trace: DecisionTrace): {
  system: string;
  user: string;
} {
  const pa = trace.inputs.proposedAction;
  const signals = pa.matched_signals?.length
    ? pa.matched_signals.join(", ")
    : "(none)";
  const history = trace.inputs.conversationHistory
    .map(
      (m) =>
        `[${m.role}] ${m.content}`,
    )
    .join("\n");

  const userPayload = [
    `## Execution decision`,
    `Outcome: execute_notify`,
    `Rationale (for you, do not paste verbatim): ${trace.parsed.rationale}`,
    ``,
    `## Proposed action`,
    `Summary: ${pa.summary}`,
    `Danger tier: ${pa.danger_tier}`,
    `Matched signals: ${signals}`,
    ``,
    `## User / org context (mock JSON)`,
    JSON.stringify(trace.inputs.userState ?? {}, null, 2),
    ``,
    `## Conversation (oldest first)`,
    history,
    ``,
    `## Prior assistant-only text (avoid repeating verbatim)`,
    assistantTranscript(trace.inputs.conversationHistory),
    ``,
    `Write the assistant's single next reply bubble.`,
  ].join("\n");

  return { system: SYSTEM, user: userPayload };
}
