# Execution decision layer (Smart AI Agent)

Prototype **execution decision layer** for a messaging-style assistant (email, calendar, reminders). Every “action” is mock-only; the pipeline decides *how* the assistant should stage the next step: silent execution, notify-after execution, confirmation, clarification, or refusal/escalation.

---

## Signals: what they are and why they exist

Signals summarize **cheap, auditable cues** derived from transcript + structured inputs so safety and urgency are not inferred only inside an opaque LLM call.

### Proposed-action inference (`lib/proposed-action.ts`)

Regex-style tags are derived from the **latest user message only** (`textForProposedActionInference`). That keeps tier and signal tags aligned with the **current** bubble so a prior harmful or unrelated line does not inflate risk for the next harmless one. Scenario bundles in the UI may still include a `proposedAction` for documentation of the sample thread, but **`resolveEffectiveProposedAction` always returns live inference** — the fixture is not merged in and does not act as a floor on danger.

| Signal (examples) | Role |
|-------------------|------|
| `payment_or_transfer`, `bulk_or_company_email`, `external_sensitive_email`, `credential_or_pii_email`, `calendar_high_impact`, `bypass_safety`, `reminder_scheduling_soft`, `read_calendar_only`, `routine_email_low` | Map language to coarse risk buckets and summaries for downstream rules and prompting. |

Each tag nudges an **estimated numeric risk score** (0–1), then a **danger tier** (low / medium / high).

### Conversation + policy signals (`lib/signals.ts`)

| Signal / field | Meaning | Why |
|----------------|---------|-----|
| **`missing_critical_context`** + **`missing_slots`** | Sends/schedules implied but recipients, times, or payment amounts aren’t explicit in the transcript. | Prevents executing on ambiguous “send it” without *who/when/how much*. |
| **`explicit_execution_confirmation`** | Latest user matches the mock UI’s explicit confirm line (not loose “yes”). | Avoids treating casual agreement as irrevocable consent. |
| **`contradiction_flag`** | Earlier turns express hold/wait/legal review; latest turn is a short affirmative. | Surfaces “looks safe now but thread said stop earlier.” |
| **`injection_attempt`** | Latest user matches instruction-override phrasing (“ignore previous rules…” — checked on **latest user only**). | Jailbreak-style overrides are policy-relevant regardless of fuzzy semantics. |
| **`risk_score`**, **`risk_tier`**, **`silent_threshold`** | Combined score from inferred action + language boosts (+ VIP/external combo), capped and bucketed. | Gives the model numeric guardrails aligned with UX thresholds. |
| **`conversationLanguageRiskBoost` notes** | Combos such as blast + confidential / wire + urgency / bulk calendar destruction. | Uses the same **latest user message** span as proposed-action inference. |
| **`vipSensitiveBoost`** | Mentions VIP contacts while external/bulk signals fire. | Extra friction for high-stakes recipients. |
| **`policy_blocked`** | Injection **or** org “payout freeze” notes in user state while payment signals are present. | Deterministic refusal path for non-negotiable rules. |

---

## Splitting responsibility: LLM vs regular code

**Regular code** owns:

- Parsing and validating API payloads (`DecideRequestBody`).
- Inferring **`ProposedAction`** from the **latest user line** only (deterministic regex); see above.
- Computing **`DecisionSignals`** (`computeSignals`).
- **Hard gates**: if `policy_blocked`, **never** call the LLM — return mandatory refusal (`runDecisionPipeline` short-circuit). Same for **`missing_critical_context`** — deterministic `ask_clarify` without LLM.
- Provider hygiene: timeouts, malformed JSON, schema validation, safe defaults (**refuse/escalate**) on failure, with rationale and `failure.kind` distinguishing **decision-step** vs **notify-reply** OpenAI failures when applicable.
- **Decision mock mode** (`EXECUTION_DECISION_USE_MOCK` or missing API key): deterministic `mockLlmDecision` for the JSON decision only. If an API key is present, a **second** completion may still run after `execute_notify` to compose the user-visible “what happened” text (simulated inbox/calendar); without a key, the client shows a short fallback string.

**LLM** owns:

- **Call 1 — execution decision**: turning **structured payload + full transcript + computed_signals** into one of five **`ExecutionDecision`** outcomes and a human-readable rationale.
- **Call 2 (optional)** — after **`execute_notify`**, a plain-text completion builds the assistant’s **simulated** follow-up message (`notifyAssistantMessage` on the trace); not used for the five-outcome JSON.
- Nuanced multi-turn reasoning where regex is insufficient — e.g. retracted consent vs new topic, ambiguous “send it” after “wait for legal”, or when hints disagree with transcript (prompt instructs careful reading).

The contract is strict: the model receives **`computed_signals`** but must obey **hard rules** in the system prompt (policy, missing slots, explicit confirmation paths).

---

## What the model decides vs what code computes deterministically

| Deterministic (always in code first) | Model decides (when LLM invoked) |
|----------------------------------------|-----------------------------------|
| Regex-based **proposed action** summary, tags, score tier from the **latest user message** (not scenario fixtures). | Which of the five outcomes applies **given full transcript**, subject to gates below. |
| Missing slots / **ask_clarify** short-circuit when critical parameters missing. | Rationale wording and nuanced tie-breaks when gates are clear. |
| Injection / payout-freeze **policy_blocked** → **refuse_escalate** without LLM. | Interpreting multi-turn threads (wait vs affirm, independent new requests). |
| **`risk_score`**, thresholds, contradiction flag, VIP boost inputs. | Mapping situation to execute_silent vs notify vs confirm_first vs refuse when **not** short-circuited. |
| After OpenAI JSON parse: **`applyExplicitConfirmationCoercion`** — flips **`confirm_first` → execute_*** when user gave explicit mock confirmation (unless still missing critical context). | *(No separate choice)* — coercion is deterministic post-parse. |

If the mock path is enabled, **all** branching can be replicated without OpenAI using `mockLlmDecision`; live mode delegates the nuanced branch to the model while preserving the same gates.

---

## Prompt design (brief)

- **Role**: Execution decision layer for mock email/calendar/reminders — outputs **single JSON object** (`decision`, `rationale`, optional `clarifying_question`).
- **Transcript-first**: Must read **`conversation_turns`** in order; latest line alone is insufficient when earlier turns constrain intent.
- **Signals as hints**: `computed_signals` are auxiliary; transcript wins on conflict, with escalation/clarification when unsure.
- **Operator instructions** are stylistic only — cannot override policy, injection handling, or missing parameters.
- **Hard constraints**: Respect `policy_blocked` / injection; if `missing_critical_context`, must **ask_clarify** not **confirm_first**; explicit mock confirmation forces execute family, not another confirm prompt.
- **Multi-request sessions**: Consecutive turns may be independent tasks — do not inherit unrelated risk unless explicitly linked.

Prompts are built in `lib/prompt.ts`; full text is exposed in the UI trace for audit.

---

## Expected failure modes

| Mode | Behavior |
|------|----------|
| **Policy / missing-context short-circuit** | LLM skipped on purpose — trace marks `policy_short_circuit` or real `missing_critical_context` when slots are missing. |
| **OpenAI failure on decision JSON call** | **`refuse_escalate`** — rationale and `failure.message` state an OpenAI error **during the execution decision step** (no raw provider text to the client). |
| **OpenAI failure on notify-reply call** | If the outcome was **`execute_notify`** but the follow-up completion fails, decision is coerced to **`refuse_escalate`** with rationale / failure metadata referring to the **notify-reply** step. |
| **Malformed or non-schema JSON** | Parse failure → refuse_escalate; `failure.kind` **`parse_error`**, message attributes bad OpenAI JSON for the decision schema. |
| **Decision mock LLM mode** | Deterministic surrogate for **call 1**; labeled in raw output. Notify-reply (**call 2**) still uses OpenAI when `OPENAI_API_KEY` is set. |

Operational risks not fully solved here: adversarial prompts that avoid regexes, multilingual inputs, inconsistent model adherence to JSON-only output, **short latest lines** (“send it”) that need full-thread context for tagging, and **UI/session drift** vs transcript (mitigated via draft vs committed messages).

---

## What we did not build (scope)

This prototype is intentionally thin where production would be thick. Out of scope for the challenge timebox:

- **Authentication and identity** — No sign-in, sessions tied to users, multi-tenant isolation, or per-user API keys. The UI is a single local demo; `userState` is editable JSON, not verified profile data.
- **Real tool execution** — No Gmail, Calendar, reminders, banking, or messaging backends. Decisions are hypothetical; nothing is sent, booked, transferred, or delivered.
- **Server-side persistence and audit store** — Decision traces exist in memory for the request and in the browser session (`localStorage`) only. There is no durable trace DB, export API, or compliance retention story.

---

## Evolving this system as **alfred_** gains riskier tools

As tool breadth grows (payments, org-wide admin, CRM writes, cross-account linking), the architecture should evolve in layers:

1. **Tool manifests**: Each tool declares side effects, reversibility, blast radius, and required arguments; missing args become structured slot checks instead of only regex.
2. **Policy engine**: Replace ad-hoc notes with versioned rules (who may invoke what, approval chains, spend limits) evaluated **before** any LLM “execute” outcome.
3. **Allow-list execution**: High-impact tools require explicit tokens (human approval, step-up auth) recorded in **`explicit_execution_confirmation`**-style signals but backed by real auth.
4. **Observability**: Correlate decision traces with actual tool calls for replay and drift detection.
5. **Defense in depth**: Keep deterministic refusal for known-bad patterns; use the LLM for classification of *novel* combinations only when gates pass.

---

## Six-month roadmap (if owning this product)

**Classifier for risk.** Train a model that ingests a proposed structured action (type + normalized parameters + a short transcript slice) and predicts **danger level / execution tier**. Use it to **replace or augment** hand-tuned regex in `inferProposedActionFromMessages`, while keeping deterministic rules as hard floors and ceilings (injection, org-policy freezes, and similar gates stay in code). The goal is better coverage of paraphrases and new surfaces, scores calibrated from labeled or logged traffic, and less churn from shipping new regex for every edge case.

**Coordinator + specialist agents.** Evolve toward one **primary agent** the user talks to, which delegates to **worker agents** scoped to domains (e.g. inbox vs calendar vs money movement). Workers propose or execute only within their toolset; they **escalate back to the coordinator** when something is ambiguous, blocked by policy, or needs user-visible confirmation—similar to how a lead routes work to specialists and pulls threads back when clarification is needed. The coordinator keeps **one conversation thread and one audit story**: policy and execution decisions stay traceable in a single place instead of scattering across isolated bots.

---
