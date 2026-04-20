import { textForProposedActionInference, tierBaseline } from "./proposed-action";
import type {
  DecisionSignals,
  DecideRequestBody,
  ProposedAction,
} from "./types";

const SILENT_THRESHOLD = 0.38;

/** Clarify when the transcript implies an act but targets/times/recipients are unclear. */
function missingSlotsFromTranscript(body: DecideRequestBody): string[] {
  const text = body.conversationHistory
    .map((m) => m.content)
    .join("\n")
    .toLowerCase();
  const missing: string[] = [];

  const wantsSend =
    /\b(send|reply|forward|ship (the )?email|fire off)\b/i.test(text) &&
    /(draft|email|message|reply)/i.test(text);
  const hasRecipient =
    /@\S+/.test(text) ||
    /\breply to\b/i.test(text) ||
    /\b(client|partner|customer)\b/i.test(text);

  if (wantsSend && !hasRecipient && !/\b(you|same thread)\b/i.test(text)) {
    missing.push("Recipient or distribution list is not clear from the transcript");
  }

  const wantsSchedule =
    /\b(schedule|book|put on (my )?calendar|set up (a )?meet|invite)\b/i.test(
      text,
    );
  const hasWhen =
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|next week|\d{1,2}(:\d{2})?\s*(am|pm)|\d{1,2}\/\d{1,2})\b/i.test(
      text,
    );

  if (wantsSchedule && !hasWhen) {
    missing.push("Time or date for the meeting/reminder is not explicit in the transcript");
  }

  const paymentIntent =
    body.proposedAction.matched_signals?.includes("payment_or_transfer");
  const amountClear =
    /\$\s*[0-9]|\b[0-9]+\s*(usd|dollars?)\b/i.test(text) || /\bamount\b.*\d/i.test(text);

  if (paymentIntent && !amountClear && body.proposedAction.danger_tier !== "low") {
    missing.push("Payment or transfer amount is not explicit in the transcript");
  }

  return missing;
}

/** True when the latest user turn is the mock UI “Confirm” line (avoids treating casual “yes” as approval). */
function detectExplicitExecutionConfirmation(
  history: DecideRequestBody["conversationHistory"],
): boolean {
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  if (!lastUser) return false;
  const c = lastUser.content;
  return (
    /Confirmed\s*[—\-]\s*go ahead with the proposed action/i.test(c) &&
    /mock only/i.test(c)
  );
}

function detectContradiction(history: DecideRequestBody["conversationHistory"]): boolean {
  const userTexts = history
    .filter((m) => m.role === "user")
    .map((m) => m.content.toLowerCase());
  if (userTexts.length < 2) return false;

  const hold =
    /(hold off|wait for|don't (send|ship)|do not|stop|legal|review first|not until)/i;
  const consent =
    /^(yep|yes|ship it|send it|go ahead|do it|schedule it|book it|sounds good)\b/i;

  let sawHold = false;
  for (const t of userTexts) {
    if (hold.test(t)) sawHold = true;
  }
  const last = userTexts[userTexts.length - 1] ?? "";
  return sawHold && consent.test(last.trim());
}

function injectionAttempt(
  history: DecideRequestBody["conversationHistory"],
): boolean {
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  if (!lastUser) return false;
  return /ignore (previous|all) (rules|policies|instructions)/i.test(
    lastUser.content,
  );
}

function conversationLanguageRiskBoost(
  history: DecideRequestBody["conversationHistory"],
): { boost: number; notes: string[] } {
  const notes: string[] = [];
  const text = textForProposedActionInference(history);
  let boost = 0;

  if (
    /\b(bcc|company[\s-]?wide|all[\s-]?hands|blast)\b/i.test(text) &&
    /(confidential|nda|salary|layoff|unreleased)/i.test(text)
  ) {
    boost += 0.42;
    notes.push(
      "Conversation combines wide distribution language with sensitive-topic cues.",
    );
  }

  if (/\b(wire|ach)\b.*\b(today|right now|urgent|asap)\b/i.test(text)) {
    boost += 0.28;
    notes.push("Conversation pairs money movement with urgency language.");
  }

  if (
    /decline\s+all|cancel\s+everything|wipe\s+(my\s+)?calendar\s+for/i.test(text)
  ) {
    boost += 0.32;
    notes.push("Conversation suggests bulk calendar destruction or mass declines.");
  }

  return { boost: Math.min(boost, 0.55), notes };
}

function vipSensitiveBoost(
  pa: ProposedAction,
  body: DecideRequestBody,
): number {
  const text = textForProposedActionInference(body.conversationHistory);
  let boost = 0;
  const vips = body.userState.vip_contacts ?? [];
  const mentionsVip = vips.some((v) => v.trim() && text.includes(v.toLowerCase()));

  if (
    mentionsVip &&
    (pa.matched_signals?.includes("external_sensitive_email") ||
      pa.matched_signals?.includes("bulk_or_company_email"))
  ) {
    boost += 0.14;
  }

  return boost;
}

export function computeSignals(body: DecideRequestBody): DecisionSignals {
  const notes: string[] = [];
  const pa = body.proposedAction;

  const missing = missingSlotsFromTranscript(body);
  const missing_critical = missing.length > 0;
  const explicit_execution_confirmation =
    detectExplicitExecutionConfirmation(body.conversationHistory);
  const contradiction = detectContradiction(body.conversationHistory);
  const injection = injectionAttempt(body.conversationHistory);
  const langRisk = conversationLanguageRiskBoost(body.conversationHistory);
  notes.push(...langRisk.notes);

  const base =
    pa.estimated_risk_score !== undefined
      ? pa.estimated_risk_score
      : tierBaseline(pa.danger_tier);

  let risk = base + langRisk.boost + vipSensitiveBoost(pa, body);

  if (injection) {
    risk = 1;
    notes.push("Possible policy override / injection phrasing in latest user message.");
  }

  if (contradiction) {
    risk = Math.min(1, risk + 0.2);
    notes.push(
      "Earlier messages asked to wait or pause before a short affirmative — elevating risk.",
    );
  }

  if (
    pa.danger_tier === "high" ||
    pa.matched_signals?.some((s) =>
      [
        "payment_or_transfer",
        "bulk_or_company_email",
        "credential_or_pii_email",
        "calendar_high_impact",
      ].includes(s),
    )
  ) {
    notes.push("High-danger tags or tier — conservative execution policy.");
  }

  let risk_tier: DecisionSignals["risk_tier"] = "low";
  if (risk >= 0.65) risk_tier = "high";
  else if (risk >= 0.35) risk_tier = "medium";

  const notesLower = body.userState.notes?.toLowerCase() ?? "";
  const payoutFreeze =
    (notesLower.includes("payout freeze") ||
      notesLower.includes("finance compliance") ||
      notesLower.includes("wire freeze")) &&
    Boolean(pa.matched_signals?.includes("payment_or_transfer"));

  const policy_blocked = payoutFreeze || injection;

  let policy_reason: string | undefined;
  if (injection) {
    policy_reason =
      "Policy: possible instruction override attempt — refuse or escalate.";
  } else if (payoutFreeze) {
    policy_reason =
      "Org policy: outbound money movement is frozen until compliance clears.";
  }

  return {
    intent_resolved: !missing_critical,
    missing_slots: missing,
    missing_critical_context: missing_critical,
    explicit_execution_confirmation,
    injection_attempt: injection,
    risk_score: Math.round(Math.min(1, risk) * 1000) / 1000,
    silent_threshold: SILENT_THRESHOLD,
    risk_tier,
    policy_blocked,
    policy_reason,
    contradiction_flag: contradiction,
    notes,
  };
}
