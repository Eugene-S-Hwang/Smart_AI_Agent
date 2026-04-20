/** Outcomes from the execution decision layer (text-assistant; all actions are mock-only). */

export type ExecutionDecision =
  | "execute_silent"
  | "execute_notify"
  | "confirm_first"
  | "ask_clarify"
  | "refuse_escalate";

export type ScenarioCategory = "clear" | "ambiguous" | "adversarial";

export type SimulateFailure =
  | "none"
  | "llm_timeout"
  | "malformed_output";

/** Coarse risk bucket from deterministic text analysis — not a fixed list of product features. */
export type DangerTier = "low" | "medium" | "high";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * Hypothetical next execution (never applied). Tier + tags summarize transcript cues.
 */
export interface ProposedAction {
  summary: string;
  danger_tier: DangerTier;
  estimated_risk_score?: number;
  /** Tags from deterministic detectors — email, calendar, reminders, scheduling, payments, etc. */
  matched_signals?: string[];
  details?: Record<string, unknown>;
}

/** Lightweight user/org context passed with each decision (all mock). */
export interface UserState {
  timezone?: string;
  primary_calendar?: string;
  /** Names or emails that deserve extra care when referenced in copy. */
  vip_contacts?: string[];
  notes?: string;
}

export interface DecideRequestBody {
  proposedAction: ProposedAction;
  conversationHistory: ChatMessage[];
  userState: UserState;
  llmInstructions?: string;
  simulateFailure?: SimulateFailure;
}

export interface ModelParsedJson {
  decision: ExecutionDecision;
  rationale: string;
  clarifying_question?: string;
}

export interface DecisionSignals {
  intent_resolved: boolean;
  missing_slots: string[];
  missing_critical_context: boolean;
  /** Latest user message is an explicit go-ahead after a confirmation prompt (mock UI / phrasing). */
  explicit_execution_confirmation: boolean;
  injection_attempt: boolean;
  risk_score: number;
  silent_threshold: number;
  risk_tier: "low" | "medium" | "high";
  policy_blocked: boolean;
  policy_reason?: string;
  contradiction_flag: boolean;
  notes: string[];
}

export interface DecisionPrompts {
  system: string;
  user: string;
}

export interface DecisionTrace {
  inputs: DecideRequestBody;
  signals: DecisionSignals;
  prompts: DecisionPrompts;
  raw_model_output: string;
  parsed: ModelParsedJson;
  failure?: {
    kind:
      | SimulateFailure
      | "missing_critical_context"
      | "parse_error"
      | "policy_short_circuit"
      | "provider_error";
    message: string;
  };
  model_invocation_skipped?: boolean;
  skipped_reason?: string;
  /** When decision is execute_notify and OpenAI produced a user-facing follow-up (simulated inbox/calendar). */
  notifyAssistantMessage?: string;
}
