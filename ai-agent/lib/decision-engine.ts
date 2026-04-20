import { buildPrompts } from "./prompt";
import { completeDecisionChat } from "./openai";
import { computeSignals } from "./signals";
import type {
  DecideRequestBody,
  DecisionTrace,
  ExecutionDecision,
  ModelParsedJson,
  SimulateFailure,
  DecisionSignals,
} from "./types";

function mergeSimulatedMissingContext(
  signals: DecisionSignals,
  simulate: SimulateFailure | undefined,
): DecisionSignals {
  if (simulate !== "missing_critical_context") return signals;
  return {
    ...signals,
    intent_resolved: false,
    missing_critical_context: true,
    missing_slots: Array.from(
      new Set([
        ...signals.missing_slots,
        "simulated: critical deployment context (e.g. target env / reviewer)",
      ]),
    ),
    notes: [
      ...signals.notes,
      "Simulation: forced missing critical context for demo.",
    ],
  };
}

function deterministicAskClarify(signals: DecisionSignals): ModelParsedJson {
  return {
    decision: "ask_clarify",
    rationale:
      "Required slots are missing — cannot safely execute until intent and targets are explicit.",
    clarifying_question:
      signals.missing_slots.length > 0
        ? `Please specify: ${signals.missing_slots.join("; ")}`
        : "What exactly should happen for email, calendar, or reminders — who, when, and to whom?",
  };
}

function deterministicRefuse(signals: DecisionSignals): ModelParsedJson {
  return {
    decision: "refuse_escalate",
    rationale:
      signals.policy_reason ??
      "Policy blocks this action — escalate to a human rather than guessing.",
  };
}

/** If the user already explicitly confirmed, do not loop on confirm_first (mock + OpenAI). */
function applyExplicitConfirmationCoercion(
  signals: DecisionSignals,
  parsed: ModelParsedJson,
): ModelParsedJson {
  if (!signals.explicit_execution_confirmation) return parsed;
  if (signals.missing_critical_context) return parsed;
  if (parsed.decision !== "confirm_first") return parsed;
  const r = signals.risk_score;
  const st = signals.silent_threshold;
  if (r < st) {
    return {
      ...parsed,
      decision: "execute_silent",
      rationale:
        "User explicitly confirmed — risk is below the silent threshold; completing without another prompt (mock).",
    };
  }
  return {
    ...parsed,
    decision: "execute_notify",
    rationale:
      "User explicitly confirmed the proposed action — proceeding with notify-after execution (mock audit trail).",
  };
}

/** Skeleton “model”: replace with real LLM call that returns the same JSON shape. */
function mockLlmDecision(
  body: DecideRequestBody,
  signals: DecisionSignals,
): ModelParsedJson {
  if (signals.policy_blocked) {
    return deterministicRefuse(signals);
  }
  if (signals.missing_critical_context) {
    return deterministicAskClarify(signals);
  }

  if (signals.explicit_execution_confirmation) {
    const r = signals.risk_score;
    const st = signals.silent_threshold;
    if (r < st) {
      return {
        decision: "execute_silent",
        rationale:
          "User explicitly confirmed — risk is below the silent threshold; completing without another interrupt (mock).",
      };
    }
    return {
      decision: "execute_notify",
      rationale:
        "Explicit confirmation recorded — proceeding with notify-after execution so the user sees what ran (mock).",
    };
  }

  const r = signals.risk_score;
  const st = signals.silent_threshold;

  if (signals.contradiction_flag && signals.risk_tier !== "low") {
    return {
      decision: "confirm_first",
      rationale:
        "Earlier messages asked to wait or pause; the latest message looks affirmative — confirm before executing.",
    };
  }

  if (r < st) {
    return {
      decision: "execute_silent",
      rationale:
        "Low risk, parameters present, and no policy flags — silent execution is acceptable for this mock assistant action.",
    };
  }

  if (r < 0.72) {
    return {
      decision: "confirm_first",
      rationale:
        "Risk is above the silent threshold — confirm with the user before executing.",
    };
  }

  if (body.proposedAction.danger_tier === "high" || r >= 0.88) {
    return {
      decision: "execute_notify",
      rationale:
        "High tier or score — prefer notify-after so the user sees an audit trail (mock).",
    };
  }

  return {
    decision: "execute_notify",
    rationale:
      "Moderate-to-high impact — execute but surface a clear notification after (mock).",
  };
}

function parseModelJson(raw: string): ModelParsedJson {
  const trimmed = raw.trim();
  const match = trimmed.match(/\{[\s\S]*\}/);
  const jsonStr = match ? match[0] : trimmed;
  const obj = JSON.parse(jsonStr) as Record<string, unknown>;

  const decision = obj.decision as ExecutionDecision;
  const rationale = String(obj.rationale ?? "");
  const clarifying_question =
    obj.clarifying_question !== undefined
      ? String(obj.clarifying_question)
      : undefined;

  const allowed: ExecutionDecision[] = [
    "execute_silent",
    "execute_notify",
    "confirm_first",
    "ask_clarify",
    "refuse_escalate",
  ];
  if (!allowed.includes(decision)) {
    throw new Error(`Invalid decision in model JSON: ${String(obj.decision)}`);
  }

  return { decision, rationale, clarifying_question };
}

function timeoutFallback(): ModelParsedJson {
  return {
    decision: "refuse_escalate",
    rationale:
      "Model did not respond in time — defaulting to refuse/escalate for safety (no silent execution).",
  };
}

function malformedRawOutput(): string {
  return `not-json-at-all { broken: true, trailing`;
}

export async function runDecisionPipeline(
  body: DecideRequestBody,
): Promise<DecisionTrace> {
  const simulate = body.simulateFailure ?? "none";
  let signals = computeSignals(body);
  signals = mergeSimulatedMissingContext(signals, simulate);

  const prompts = buildPrompts(body, signals);

  // Deterministic short-circuit: policy (includes injection policy)
  if (signals.policy_blocked) {
    const parsed = deterministicRefuse(signals);
    return {
      inputs: body,
      signals,
      prompts,
      raw_model_output:
        "(model not invoked — deterministic policy_short_circuit)",
      parsed,
      failure: {
        kind: "policy_short_circuit",
        message:
          "Policy blocked before LLM; refusal is mandatory in this prototype.",
      },
      model_invocation_skipped: true,
      skipped_reason: "policy_short_circuit",
    };
  }

  // Deterministic short-circuit: missing parameters
  if (signals.missing_critical_context) {
    const parsed = deterministicAskClarify(signals);
    return {
      inputs: body,
      signals,
      prompts,
      raw_model_output:
        "(model not invoked — deterministic missing_critical_context)",
      parsed,
      failure: {
        kind: "missing_critical_context",
        message:
          "Missing critical slots — ask clarifying questions instead of executing.",
      },
      model_invocation_skipped: true,
      skipped_reason: "missing_critical_context",
    };
  }

  if (simulate === "llm_timeout") {
    return {
      inputs: body,
      signals,
      prompts,
      raw_model_output: "(timeout — no completion received)",
      parsed: timeoutFallback(),
      failure: {
        kind: "llm_timeout",
        message:
          "Simulated provider timeout; safe default is refuse/escalate, not silent execute.",
      },
    };
  }

  if (simulate === "malformed_output") {
    const raw = malformedRawOutput();
    try {
      const parsed = parseModelJson(raw);
      return {
        inputs: body,
        signals,
        prompts,
        raw_model_output: raw,
        parsed,
      };
    } catch {
      return {
        inputs: body,
        signals,
        prompts,
        raw_model_output: raw,
        parsed: {
          decision: "refuse_escalate",
          rationale:
            "Model output was not valid JSON — refusing to avoid executing on a guessed interpretation.",
        },
        failure: {
          kind: "malformed_output",
          message: "Could not parse JSON from model output.",
        },
      };
    }
  }

  const useMock =
    !process.env.OPENAI_API_KEY?.trim() ||
    process.env.EXECUTION_DECISION_USE_MOCK === "1";

  if (!useMock) {
    const result = await completeDecisionChat(prompts);
    if (!result.ok) {
      return {
        inputs: body,
        signals,
        prompts,
        raw_model_output: `(OpenAI request failed: ${result.error})`,
        parsed: {
          decision: "refuse_escalate",
          rationale: result.timedOut
            ? "OpenAI request timed out — defaulting to refuse/escalate for safety."
            : `OpenAI request failed — refusing for safety. (${result.error})`,
        },
        failure: {
          kind: result.timedOut ? "llm_timeout" : "provider_error",
          message: result.error,
        },
      };
    }

    const raw = result.content;
    try {
      const parsed = applyExplicitConfirmationCoercion(
        signals,
        parseModelJson(raw),
      );
      return {
        inputs: body,
        signals,
        prompts,
        raw_model_output: raw,
        parsed,
      };
    } catch {
      return {
        inputs: body,
        signals,
        prompts,
        raw_model_output: raw,
        parsed: {
          decision: "refuse_escalate",
          rationale:
            "Model returned JSON that does not match the expected decision schema — refusing.",
        },
        failure: {
          kind: "parse_error",
          message: "Could not parse JSON from OpenAI response.",
        },
      };
    }
  }

  const parsed = mockLlmDecision(body, signals);
  const raw_model_output =
    JSON.stringify(parsed) +
    "\n\n# mock_llm_mode: set OPENAI_API_KEY in ai-agent/.env.local (unset EXECUTION_DECISION_USE_MOCK) to call OpenAI.";

  return {
    inputs: body,
    signals,
    prompts,
    raw_model_output,
    parsed,
  };
}
