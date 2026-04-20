import type { ChatMessage, DangerTier, ProposedAction } from "./types";

/** Dropdown value for “blank slate” — no bundled transcript or default bundle. */
export const NONE_SCENARIO_ID = "__none__";

export function scoreToTier(score: number): DangerTier {
  const s = Math.min(1, Math.max(0, score));
  if (s < 0.35) return "low";
  if (s < 0.65) return "medium";
  return "high";
}

export function tierBaseline(t: DangerTier): number {
  const m: Record<DangerTier, number> = {
    low: 0.22,
    medium: 0.52,
    high: 0.82,
  };
  return m[t];
}

function roundScore(x: number): number {
  return Math.round(Math.min(1, Math.max(0, x)) * 1000) / 1000;
}

function buildSummary(signals: string[]): string {
  if (signals.includes("payment_or_transfer"))
    return "Money movement, payout, or transfer (inferred from conversation)";
  if (signals.includes("bulk_or_company_email"))
    return "Wide-audience or company-wide email (inferred from conversation)";
  if (signals.includes("credential_or_pii_email"))
    return "Sharing passwords, financial, or sensitive details via message or email (inferred)";
  if (signals.includes("external_sensitive_email"))
    return "Outbound email to external / partner / client contacts (inferred)";
  if (signals.includes("calendar_high_impact"))
    return "Destructive or org-wide calendar change (inferred from conversation)";
  if (signals.includes("bypass_safety"))
    return "Bypass confirmations, filters, or normal safeguards (inferred)";
  if (signals.includes("reminder_scheduling_soft"))
    return "Reminder or lightweight scheduling cue (inferred)";
  if (signals.includes("email_content_lookup"))
    return "Read-only email / thread listing or message body (inferred)";
  if (signals.includes("information_lookup"))
    return "Read-only information lookup (calendar, inbox, or summary — inferred)";
  if (signals.includes("read_calendar_only"))
    return "Read-only calendar or availability check (inferred)";
  if (signals.includes("routine_email_low"))
    return "Routine inbox triage or low-impact email action (inferred)";
  return "General assistant request — no strong danger pattern matched (inferred)";
}

/**
 * Text span for regex-based proposed-action inference: the **latest user message only**.
 * Consecutive user bubbles after an assistant reply are treated as separate intents (calendar,
 * then an unsafe ask, then a reminder); merging them caused the last harmless line to inherit
 * danger tags from an earlier message.
 */
/** Same scope as proposed-action regex inference; also used by `signals`. */
export function textForProposedActionInference(messages: ChatMessage[]): string {
  const users = messages.filter((m) => m.role === "user");
  if (users.length === 0) return "";
  return users[users.length - 1]!.content.trim().toLowerCase();
}

/**
 * Infer danger tier and tags from the **current** proposed intent (see
 * `textForProposedActionInference`), not from every prior line in the thread.
 */
export function inferProposedActionFromMessages(
  messages: ChatMessage[],
): ProposedAction {
  const t = textForProposedActionInference(messages);
  const matched_signals: string[] = [];

  let score = 0.14;

  if (
    /\b(wire|ach|zelle|venmo|paypal)\b/i.test(t) ||
    /\b(send|transfer)\s+\$?\s*[0-9][0-9,]*/i.test(t) ||
    /\bpayout\b|\binvoice\b.*\bpay\b/i.test(t)
  ) {
    score += 0.5;
    matched_signals.push("payment_or_transfer");
  }

  if (
    /\bbcc\b|\ball[\s-]?hands\b|\bcompany[\s-]?wide\b|\beveryone\s+at\b|\bblast\b/i.test(
      t,
    )
  ) {
    score += 0.46;
    matched_signals.push("bulk_or_company_email");
  }

  if (
    /external|client|partner|outside (the )?company|press|journalist/i.test(t) &&
    /(send|reply|forward|draft|email|message)/i.test(t)
  ) {
    score += 0.22;
    matched_signals.push("external_sensitive_email");
  }

  if (
    /password|passcode|ssn|social security|credit card|bank account|routing/i.test(t) &&
    /(email|forward|send|paste|attach)/i.test(t)
  ) {
    score += 0.44;
    matched_signals.push("credential_or_pii_email");
  }

  if (
    /cancel\s+(all|everyone)|delete\s+(my\s+)?calendar|wipe\s+(my\s+)?(day|week)|decline\s+all\s+meetings/i.test(
      t,
    )
  ) {
    score += 0.42;
    matched_signals.push("calendar_high_impact");
  }

  if (
    /ignore (previous|all)|bypass|without (asking|confirm)|skip (the )?(inbox|filter|spam)/i.test(
      t,
    )
  ) {
    score += 0.28;
    matched_signals.push("bypass_safety");
  }

  if (
    /schedule|book|put on (my )?calendar|invite|meet(ing)? with/i.test(t) ||
    /\b(remind me|reminder|notification|alarm|alert)\b/i.test(t) ||
    /\bset (a |an )?(notification|reminder|alarm)\b/i.test(t)
  ) {
    score += 0.12;
    matched_signals.push("reminder_scheduling_soft");
  }

  const emailContentLookup =
    /\b(read|tell me|show me)\s+(me\s+)?(what\s+)?(the\s+)?(vip\s+)?(email|thread|mail|message)\b/i.test(
      t,
    ) ||
    /\bwhat\s+(does|did)\s+(the\s+)?(vip\s+)?(email|thread)\s+(say|contain)/i.test(t) ||
    /\bplease read\b.*\b(email|what|the)\b/i.test(t) ||
    /\b(email|thread)\s+(says|said|body|contents?)\b/i.test(t) ||
    /\b(which|what was|what are)\b.*\b(one of )?(the\s+)?(vip\s+)?emails?\b/i.test(t) ||
    /\bwhat\s+was\s+one\s+of\s+the\s+emails/i.test(t) ||
    /\b(emails?|threads?)\b.*\b(what|which|say|about)\b/i.test(t) ||
    /\b(email|vip|roadmap|subject)\b.*\b(draft|thread|client)\b/i.test(t);

  if (emailContentLookup) {
    score += 0.07;
    matched_signals.push("email_content_lookup");
  }

  if (
    /what'?s on (my )?calendar|show\s+(me\s+)?(my\s+)?(today'?s\s+)?calendar|show\s+(me\s+)?(my\s+)?schedule\b|show\s+(my\s+)?today\b|today'?s\s+calendar|am i free|when am i busy/i.test(
      t,
    )
  ) {
    score += 0.06;
    matched_signals.push("read_calendar_only");
  }

  if (
    !matched_signals.includes("email_content_lookup") &&
    (/\b(tell me|give me|what (are|were)|list|summarize|how many)\b.*\b(meetings?|events?|inbox|unread|mail|messages?)\b/i.test(
      t,
    ) ||
      /\b(check|look up|pull up)\s+(my\s+)?(schedule|calendar|inbox)\b/i.test(t))
  ) {
    score += 0.07;
    matched_signals.push("information_lookup");
  }

  if (
    /snooze|mark as read|archive (this )?(thread)?|draft (a )?(quick )?reply/i.test(t)
  ) {
    score += 0.08;
    matched_signals.push("routine_email_low");
  }

  score = roundScore(score);
  const danger_tier = scoreToTier(score);

  return {
    summary: buildSummary(matched_signals),
    danger_tier,
    estimated_risk_score: score,
    matched_signals: [...new Set(matched_signals)],
    details: {},
  };
}

/**
 * Effective classification for the API is **always** from `inferProposedActionFromMessages`:
 * danger tier and tags follow the **latest user message** only (see `textForProposedActionInference`).
 *
 * Scenario JSON may still include a `proposedAction` as documentation for the bundled transcript,
 * but it is **not** merged or used as a floor — so a harmless new line after a risky scenario
 * demo is not stuck at the fixture’s tier.
 */
export function resolveEffectiveProposedAction(
  _scenarioId: string,
  _scenarioBody: { proposedAction: ProposedAction } | undefined,
  messages: ChatMessage[],
): ProposedAction {
  return inferProposedActionFromMessages(messages);
}
