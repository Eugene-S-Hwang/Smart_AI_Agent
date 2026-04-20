"use client";

import { useEffect, useMemo, useState } from "react";
import { SCENARIOS } from "@/lib/scenarios";
import {
  CHAT_SESSION_STORAGE_KEY,
  messagesFromTimeline,
  splitTrailingUserDraft,
  stripLastDecisionRound,
  stripTrailingVerdictCard,
  timelineFromScenarioMessages,
  verdictFromTrace,
  type ChatSessionEvent,
  type PersistedChatSession,
  type VerdictSnapshot,
} from "@/lib/chat-session";
import {
  NONE_SCENARIO_ID,
  resolveEffectiveProposedAction,
} from "@/lib/proposed-action";
import type {
  DecisionTrace,
  ChatMessage,
  UserState,
  SimulateFailure,
} from "@/lib/types";

function lastUserContent(messages: ChatMessage[]): string | undefined {
  const users = messages.filter((m) => m.role === "user");
  return users.length ? users[users.length - 1]!.content : undefined;
}

/** Messages shown in bubbles plus an unsent composer line (scenario draft or next reply). */
function mergeComposerDraft(
  timelineMsgs: ChatMessage[],
  composerTrimmed: string,
): ChatMessage[] {
  const d = composerTrimmed.trim();
  if (!d) return timelineMsgs;
  const lu = lastUserContent(timelineMsgs)?.trim();
  if (lu === d) return timelineMsgs;
  return [...timelineMsgs, { role: "user" as const, content: d }];
}

function pretty(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

const FAILURE_OPTIONS: { value: SimulateFailure; label: string }[] = [
  { value: "none", label: "None (normal path)" },
  {
    value: "llm_timeout",
    label: "Simulate LLM timeout (visible failure demo)",
  },
  {
    value: "malformed_output",
    label: "Simulate malformed model output",
  },
  {
    value: "missing_critical_context",
    label: "Simulate missing critical context (forced)",
  },
];

export default function Home() {
  const initialHistory = SCENARIOS[0].body.conversationHistory;
  const initialSplit = splitTrailingUserDraft(initialHistory);

  const [hydrated, setHydrated] = useState(false);
  const [scenarioId, setScenarioId] = useState<string>(SCENARIOS[0].id);
  const [timeline, setTimeline] = useState<ChatSessionEvent[]>(() =>
    timelineFromScenarioMessages(initialSplit.committed),
  );
  const [userState, setUserState] = useState<string>(
    pretty(SCENARIOS[0].body.userState ?? {}),
  );
  const [llmInstructions, setLlmInstructions] = useState<string>(
    SCENARIOS[0].body.llmInstructions ?? "",
  );
  const [simulateFailure, setSimulateFailure] = useState<SimulateFailure>(
    SCENARIOS[0].body.simulateFailure ?? "none",
  );
  const [composerText, setComposerText] = useState(
    initialSplit.trailingUserDraft,
  );
  const [trace, setTrace] = useState<DecisionTrace | null>(null);
  const [loading, setLoading] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  const selectedMeta = useMemo(() => {
    if (scenarioId === NONE_SCENARIO_ID) return undefined;
    return SCENARIOS.find((s) => s.id === scenarioId);
  }, [scenarioId]);

  const chatMessages = useMemo(
    () => messagesFromTimeline(timeline),
    [timeline],
  );

  const messagesIncludingDraft = useMemo(
    () => mergeComposerDraft(chatMessages, composerText),
    [chatMessages, composerText],
  );

  const effectiveProposedAction = useMemo(() => {
    return resolveEffectiveProposedAction(
      scenarioId,
      selectedMeta?.body,
      messagesIncludingDraft,
    );
  }, [scenarioId, selectedMeta, messagesIncludingDraft]);

  const trimmedComposer = composerText.trim();
  const lastCommittedUser = lastUserContent(chatMessages)?.trim();
  const draftIsExtraUserLine =
    Boolean(trimmedComposer) &&
    (lastCommittedUser === undefined ||
      trimmedComposer !== lastCommittedUser);
  const primaryChatButtonLabel = loading
    ? "Deciding…"
    : draftIsExtraUserLine
      ? "Add & decide"
      : "Run decision";
  const primaryChatDisabled =
    loading || messagesIncludingDraft.length === 0;

  useEffect(() => {
    queueMicrotask(() => {
      try {
        const raw = localStorage.getItem(CHAT_SESSION_STORAGE_KEY);
        if (!raw) return;
        const p = JSON.parse(raw) as PersistedChatSession & { v?: number };
        if (!Array.isArray(p.timeline)) return;

        const okScenario =
          p.scenarioId === NONE_SCENARIO_ID ||
          SCENARIOS.some((s) => s.id === p.scenarioId);
        if (!okScenario) return;
        if (p.v !== 2 && p.v !== 1) return;

        setScenarioId(p.scenarioId);
        setTimeline(p.timeline);
        setUserState(p.userState);
        setLlmInstructions(p.llmInstructions ?? "");
        setSimulateFailure((p.simulateFailure as SimulateFailure) ?? "none");
        setComposerText(
          typeof p.composerDraft === "string" ? p.composerDraft : "",
        );
      } catch {
        /* ignore corrupt storage */
      } finally {
        setHydrated(true);
      }
    });
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const payload: PersistedChatSession = {
      v: 2,
      scenarioId,
      timeline,
      composerDraft: composerText,
      userState,
      llmInstructions,
      simulateFailure,
    };
    try {
      localStorage.setItem(CHAT_SESSION_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* quota */
    }
  }, [
    hydrated,
    scenarioId,
    timeline,
    composerText,
    userState,
    llmInstructions,
    simulateFailure,
  ]);

  function applyScenario(id: string) {
    if (id === NONE_SCENARIO_ID) {
      setTimeline([]);
      setUserState(pretty({}));
      setLlmInstructions("");
      setSimulateFailure("none");
      setTrace(null);
      setRequestError(null);
      setComposerText("");
      return;
    }
    const s = SCENARIOS.find((x) => x.id === id);
    if (!s) return;
    const { committed, trailingUserDraft } = splitTrailingUserDraft(
      s.body.conversationHistory,
    );
    setTimeline(timelineFromScenarioMessages(committed));
    setUserState(pretty(s.body.userState ?? {}));
    setLlmInstructions(s.body.llmInstructions ?? "");
    setSimulateFailure(s.body.simulateFailure ?? "none");
    setTrace(null);
    setRequestError(null);
    setComposerText(trailingUserDraft);
  }

  function clearSession() {
    try {
      localStorage.removeItem(CHAT_SESSION_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    applyScenario(scenarioId);
  }

  async function runPipeline(
    nextTimeline: ChatSessionEvent[],
    options?: { commitPendingUser?: string },
  ) {
    const pending = options?.commitPendingUser?.trim();
    let messages = messagesFromTimeline(nextTimeline);
    if (pending) {
      const lu = lastUserContent(messages)?.trim();
      if (lu !== pending) {
        messages = [...messages, { role: "user", content: pending }];
      }
    }

    if (messages.length === 0) {
      setRequestError("Add at least one message (or pick a scenario with a transcript).");
      return;
    }

    const pendingInsertsBubble =
      Boolean(pending) &&
      lastUserContent(messagesFromTimeline(nextTimeline))?.trim() !== pending;

    setLoading(true);
    setRequestError(null);
    try {
      let state: UserState;
      try {
        state = JSON.parse(userState) as UserState;
      } catch {
        throw new Error("Invalid JSON in user context state.");
      }

      const fixture = SCENARIOS.find((s) => s.id === scenarioId);
      const proposed = resolveEffectiveProposedAction(
        scenarioId,
        fixture?.body,
        messages,
      );

      const res = await fetch("/api/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposedAction: proposed,
          conversationHistory: messages,
          userState: state,
          llmInstructions: llmInstructions.trim() || undefined,
          simulateFailure,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error ?? res.statusText);
      }
      const t = data as DecisionTrace;
      setTrace(t);

      const verdictEvt = {
        type: "verdict" as const,
        verdict: verdictFromTrace(t),
      };
      const events: ChatSessionEvent[] = [...nextTimeline];
      if (pendingInsertsBubble && pending) {
        events.push({
          type: "message",
          message: { role: "user", content: pending },
        });
      }
      events.push(verdictEvt);

      if (t.parsed.decision === "ask_clarify") {
        const clarify =
          (t.parsed.clarifying_question ?? t.parsed.rationale ?? "").trim();
        if (clarify) {
          events.push({
            type: "message",
            message: { role: "assistant", content: clarify },
          });
        }
      }

      setTimeline(events);
      if (pendingInsertsBubble) {
        setComposerText("");
      }
    } catch (e) {
      setTrace(null);
      setRequestError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  function strippedTimelineForRun(): ChatSessionEvent[] {
    return stripLastDecisionRound(stripTrailingVerdictCard(timeline));
  }

  /**
   * Re-runs on committed bubbles only, or commits the composer as the next user line
   * (scenario draft / new message) on success — the bubble appears only after the decision returns.
   */
  async function submitComposerOrRunPipeline() {
    if (loading) return;
    const trimmed = composerText.trim();
    const stripped = strippedTimelineForRun();
    const baseMsgs = messagesFromTimeline(stripped);
    const lastBaseUser = lastUserContent(baseMsgs)?.trim();

    if (baseMsgs.length === 0 && !trimmed) {
      setRequestError(
        "Add at least one message (or pick a scenario with a transcript).",
      );
      return;
    }

    setTrace(null);

    if (
      baseMsgs.length > 0 &&
      (!trimmed || lastBaseUser === trimmed)
    ) {
      await runPipeline(stripped);
      return;
    }

    if (trimmed) {
      await runPipeline(stripped, { commitPendingUser: trimmed });
    }
  }

  async function runDecision() {
    setTrace(null);
    const trimmed = composerText.trim();
    const stripped = strippedTimelineForRun();
    const baseMsgs = messagesFromTimeline(stripped);
    const lastBase = lastUserContent(baseMsgs)?.trim();

    if (trimmed && lastBase !== trimmed) {
      await runPipeline(stripped, { commitPendingUser: trimmed });
      return;
    }
    await runPipeline(stripped);
  }

  async function confirmMockAction() {
    if (loading) return;
    setTrace(null);
    await runPipeline(stripTrailingVerdictCard(timeline), {
      commitPendingUser:
        "Confirmed — go ahead with the proposed action (mock only; nothing is sent or booked for real).",
    });
  }

  async function declineMockAction() {
    if (loading) return;
    setTrace(null);
    await runPipeline(stripTrailingVerdictCard(timeline), {
      commitPendingUser:
        "Cancel — don’t proceed with that action after all (mock).",
    });
  }

  if (!hydrated) {
    return (
      <div className="flex min-h-full items-center justify-center bg-zinc-50 px-4 text-sm text-zinc-500 dark:bg-zinc-950 dark:text-zinc-400">
        Loading session…
      </div>
    );
  }

  return (
    <div className="min-h-full bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6">
        <header className="space-y-2 border-b border-zinc-200 pb-6 dark:border-zinc-800">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            MVP skeleton · email, calendar, reminders (mock)
          </p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Execution decision layer
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            Sends, invites, wires, and calendar writes are{" "}
            <strong className="font-medium text-zinc-800 dark:text-zinc-200">
              never executed for real
            </strong>
            . The payload includes a{" "}
            <strong className="font-medium text-zinc-800 dark:text-zinc-200">
              danger tier + score + signal tags
            </strong>{" "}
            from the current user intent window (merged with a preloaded scenario when selected).
            Use <strong className="font-medium text-zinc-800 dark:text-zinc-200">Run decision</strong> on the loaded transcript, or type a new line and use <strong className="font-medium text-zinc-800 dark:text-zinc-200">Add & decide</strong>.
          </p>
        </header>

        {/* Session chat — scenario transcript + your messages + verdicts */}
        <section className="rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
                Session chat
              </h2>
              <p className="text-xs text-zinc-500">
                Scenarios load prior turns into the thread; the latest user line stays in the
                composer until you run the decision (then it appears as sent above).{" "}
                <span className="font-medium text-zinc-600 dark:text-zinc-400">
                  Run decision
                </span>{" "}
                evaluates the chat as-is;{" "}
                <span className="font-medium text-zinc-600 dark:text-zinc-400">
                  Add & decide
                </span>{" "}
                appends your text first. Persists after refresh.
              </p>
            </div>
            <button
              type="button"
              onClick={clearSession}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Reset session (reload scenario)
            </button>
          </div>

          <div className="max-h-[min(520px,55vh)] space-y-4 overflow-y-auto px-4 py-4">
            <div className="rounded-xl border border-amber-200/80 bg-amber-50/90 px-4 py-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/40">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-900/80 dark:text-amber-200/90">
                Effective proposed action (computed for API)
              </p>
              <p className="mt-1 text-xs text-amber-900/80 dark:text-amber-300/90">
                Higher inferred score (current intent window) overrides a milder preloaded scenario.
                “No scenario” infers only from messages.
              </p>
              <p className="mt-2 font-medium text-amber-950 dark:text-amber-100">
                {effectiveProposedAction.summary}
              </p>
              <p className="mt-2 text-xs font-medium uppercase tracking-wide text-amber-900/85 dark:text-amber-200/85">
                Danger tier:{" "}
                <span className="font-mono normal-case">
                  {effectiveProposedAction.danger_tier}
                </span>
                {effectiveProposedAction.estimated_risk_score !== undefined && (
                  <>
                    {" "}
                    · score{" "}
                    <span className="font-mono normal-case">
                      {effectiveProposedAction.estimated_risk_score.toFixed(3)}
                    </span>
                  </>
                )}
              </p>
              {(effectiveProposedAction.matched_signals?.length ?? 0) > 0 && (
                <p className="mt-1 font-mono text-[11px] text-amber-900/85 dark:text-amber-300/85">
                  signals: {effectiveProposedAction.matched_signals?.join(", ")}
                </p>
              )}
              {effectiveProposedAction.details &&
                Object.keys(effectiveProposedAction.details).length > 0 && (
                  <p className="mt-1 font-mono text-xs text-amber-900/90 dark:text-amber-200/80">
                    details: {pretty(effectiveProposedAction.details)}
                  </p>
                )}
            </div>

            <div className="space-y-3">
              {timeline.map((event, i) =>
                event.type === "message" ? (
                  <ChatBubble key={`m-${i}-${event.message.content.slice(0, 24)}`} message={event.message} />
                ) : (
                  <VerdictBubble
                    key={event.verdict.id}
                    verdict={event.verdict}
                    showMockConfirmation={
                      event.verdict.decision === "confirm_first" &&
                      i === timeline.length - 1 &&
                      !loading
                    }
                    onConfirmMock={() => void confirmMockAction()}
                    onDeclineMock={() => void declineMockAction()}
                  />
                ),
              )}
            </div>

            {timeline.length === 0 && (
              <p className="text-center text-sm text-zinc-500">
                {trimmedComposer
                  ? "Nothing sent yet — your line is only in the composer until you run the decision."
                  : "No messages — pick a scenario or type below."}
              </p>
            )}
          </div>

          <div className="border-t border-zinc-200 bg-zinc-50/80 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950/50">
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={composerText}
                onChange={(e) => setComposerText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (!primaryChatDisabled) {
                      void submitComposerOrRunPipeline();
                    }
                  }
                }}
                placeholder={
                  chatMessages.length > 0 || trimmedComposer
                    ? "Your next user message (shown here until you run — then it appears in the thread)"
                    : "Type a user message to start…"
                }
                className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-950"
              />
              <button
                type="button"
                onClick={() => void submitComposerOrRunPipeline()}
                disabled={primaryChatDisabled}
                className="shrink-0 rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-white disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-900"
              >
                {primaryChatButtonLabel}
              </button>
            </div>
          </div>
        </section>

        <div className="grid gap-8 lg:grid-cols-2">
          <section className="space-y-4 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
              Input
            </h2>

            <div className="space-y-2">
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Scenario (optional)
              </label>
              <select
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                value={scenarioId}
                onChange={(e) => {
                  const id = e.target.value;
                  setScenarioId(id);
                  applyScenario(id);
                }}
              >
                <option value={NONE_SCENARIO_ID}>
                  No scenario — blank chat (infer action from messages only)
                </option>
                {SCENARIOS.map((s) => (
                  <option key={s.id} value={s.id}>
                    [{s.category}] {s.title}
                  </option>
                ))}
              </select>
              {selectedMeta ? (
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  {selectedMeta.description}
                </p>
              ) : (
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  Start typing; the pipeline infers structured actions from what you say.
                </p>
              )}
            </div>

            <details className="rounded-lg border border-zinc-200 dark:border-zinc-700">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Advanced · conversation as JSON (synced from chat)
              </summary>
              <textarea
                className="font-mono min-h-36 w-full resize-y border-t border-zinc-200 bg-zinc-50 p-3 text-xs leading-relaxed dark:border-zinc-700 dark:bg-zinc-950"
                value={pretty(messagesIncludingDraft)}
                readOnly
                spellCheck={false}
              />
            </details>

            <div className="space-y-2">
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                User context (JSON) — timezone, calendar, VIPs, notes
              </label>
              <textarea
                className="font-mono h-28 w-full resize-y rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-xs leading-relaxed dark:border-zinc-700 dark:bg-zinc-950"
                value={userState}
                onChange={(e) => setUserState(e.target.value)}
                spellCheck={false}
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Instructions to the model (optional)
              </label>
              <p className="text-xs text-zinc-500 dark:text-zinc-500">
                Freeform guidance merged into the user prompt as{" "}
                <code className="rounded bg-zinc-200 px-1 font-mono text-[10px] dark:bg-zinc-800">
                  operator_instructions
                </code>
                . Does not override policy blocks or missing parameters.
              </p>
              <textarea
                className="min-h-[88px] w-full resize-y rounded-lg border border-zinc-300 bg-white p-3 text-sm leading-relaxed dark:border-zinc-700 dark:bg-zinc-950"
                value={llmInstructions}
                onChange={(e) => setLlmInstructions(e.target.value)}
                placeholder='e.g. "Prefer confirm_first over execute_notify when risk_tier is medium."'
                spellCheck={true}
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Failure simulation (challenge: ≥1 visible path)
              </label>
              <select
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                value={simulateFailure}
                onChange={(e) =>
                  setSimulateFailure(e.target.value as SimulateFailure)
                }
              >
                {FAILURE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              onClick={() => void runDecision()}
              disabled={loading}
              className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2.5 text-sm font-medium text-zinc-800 transition hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              {loading
                ? "Running…"
                : "Re-run decision (same as Run decision in the chat bar)"}
            </button>

            {requestError && (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
                {requestError}
              </p>
            )}
          </section>

          <section className="space-y-4">
            <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
                Verdict
              </h2>
              {!trace ? (
                <p className="mt-3 text-sm text-zinc-500">
                  Run the pipeline to see decision + rationale.
                </p>
              ) : (
                <div className="mt-3 space-y-3">
                  <div>
                    <p className="text-xs font-medium uppercase text-zinc-500">
                      Decision
                    </p>
                    <p className="font-mono text-lg font-semibold text-emerald-700 dark:text-emerald-400">
                      {trace.parsed.decision}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-medium uppercase text-zinc-500">
                      Rationale
                    </p>
                    <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
                      {trace.parsed.rationale}
                    </p>
                  </div>
                  {trace.parsed.clarifying_question && (
                    <div>
                      <p className="text-xs font-medium uppercase text-zinc-500">
                        Clarifying question
                      </p>
                      <p className="text-sm text-zinc-700 dark:text-zinc-300">
                        {trace.parsed.clarifying_question}
                      </p>
                    </div>
                  )}
                  {trace.failure && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                      <span className="font-semibold">Failure / guard path: </span>
                      {trace.failure.kind} — {trace.failure.message}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
                Look under the hood
              </h2>
              <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                Required trace: inputs → computed signals → exact prompts → raw model
                output → parsed JSON.
              </p>

              {!trace ? (
                <p className="mt-3 text-sm text-zinc-500">
                  No run yet — expand sections after you run the pipeline.
                </p>
              ) : (
                <div className="mt-4 space-y-3">
                  <TraceBlock title="1. Inputs (request payload)" content={pretty(trace.inputs)} />
                  <TraceBlock
                    title="2. Signals & rules (deterministic)"
                    content={pretty(trace.signals)}
                  />
                  <details className="group rounded-lg border border-zinc-200 dark:border-zinc-700">
                    <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                      3. Exact prompt — system
                    </summary>
                    <pre className="max-h-64 overflow-auto border-t border-zinc-200 bg-zinc-50 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap dark:border-zinc-700 dark:bg-zinc-950">
                      {trace.prompts.system}
                    </pre>
                  </details>
                  <details className="group rounded-lg border border-zinc-200 dark:border-zinc-700">
                    <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                      3. Exact prompt — user (payload)
                    </summary>
                    <pre className="max-h-80 overflow-auto border-t border-zinc-200 bg-zinc-50 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap dark:border-zinc-700 dark:bg-zinc-950">
                      {trace.prompts.user}
                    </pre>
                  </details>
                  <TraceBlock
                    title="4. Raw model output"
                    content={trace.raw_model_output}
                    mono
                  />
                  <TraceBlock
                    title="5. Parsed decision"
                    content={pretty(trace.parsed)}
                  />
                  {(trace.model_invocation_skipped || trace.skipped_reason) && (
                    <p className="text-xs text-zinc-600 dark:text-zinc-400">
                      Model call skipped: {trace.skipped_reason ?? "yes"} — prompts are
                      still shown for audit.
                    </p>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const label =
    message.role === "assistant"
      ? "Assistant"
      : message.role === "user"
        ? "You"
        : message.role;
  return (
    <div
      className={`flex ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`max-w-[90%] rounded-2xl px-4 py-2.5 text-sm shadow-sm sm:max-w-[85%] ${
          isUser
            ? "rounded-br-md bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
            : "rounded-bl-md border border-zinc-200 bg-white text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        }`}
      >
        <p className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
          {label}
        </p>
        <p className="mt-1 whitespace-pre-wrap leading-relaxed">{message.content}</p>
      </div>
    </div>
  );
}

function VerdictBubble({
  verdict,
  showMockConfirmation,
  onConfirmMock,
  onDeclineMock,
}: {
  verdict: VerdictSnapshot;
  showMockConfirmation?: boolean;
  onConfirmMock?: () => void;
  onDeclineMock?: () => void;
}) {
  return (
    <div className="flex justify-center">
      <div className="w-full max-w-xl rounded-xl border border-emerald-300/80 bg-emerald-50 px-4 py-3 text-sm shadow-sm dark:border-emerald-800 dark:bg-emerald-950/50">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-emerald-200/80 pb-2 dark:border-emerald-800/80">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-900 dark:text-emerald-200">
            Decision layer
          </span>
          <time
            className="text-[10px] text-emerald-800/90 dark:text-emerald-300/90"
            dateTime={new Date(verdict.ts).toISOString()}
          >
            {new Date(verdict.ts).toLocaleString()}
          </time>
        </div>
        <p className="mt-2 font-mono text-base font-semibold text-emerald-900 dark:text-emerald-300">
          {verdict.decision}
        </p>
        <p className="mt-2 text-sm leading-relaxed text-emerald-950/95 dark:text-emerald-100/95">
          {verdict.rationale}
        </p>
        {verdict.failure && (
          <p className="mt-2 rounded-lg bg-amber-100/80 px-2 py-1 text-xs text-amber-950 dark:bg-amber-950/40 dark:text-amber-100">
            {verdict.failure.kind}: {verdict.failure.message}
          </p>
        )}
        {showMockConfirmation && onConfirmMock && onDeclineMock && (
          <div className="mt-4 flex flex-wrap gap-2 border-t border-emerald-200/80 pt-3 dark:border-emerald-800/80">
            <button
              type="button"
              onClick={onConfirmMock}
              className="rounded-lg bg-emerald-700 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-800 dark:bg-emerald-600 dark:hover:bg-emerald-500"
            >
              Confirm — run mock action
            </button>
            <button
              type="button"
              onClick={onDeclineMock}
              className="rounded-lg border border-emerald-400/80 bg-white px-4 py-2 text-xs font-medium text-emerald-950 hover:bg-emerald-100/80 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-100 dark:hover:bg-emerald-900"
            >
              Not now
            </button>
            <p className="w-full text-[10px] text-emerald-900/80 dark:text-emerald-300/90">
              Mock only — nothing is executed on a real inbox or calendar.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function TraceBlock({
  title,
  content,
  mono,
}: {
  title: string;
  content: string;
  mono?: boolean;
}) {
  return (
    <details className="rounded-lg border border-zinc-200 dark:border-zinc-700" open>
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-zinc-700 dark:text-zinc-300">
        {title}
      </summary>
      <pre
        className={`max-h-64 overflow-auto border-t border-zinc-200 bg-zinc-50 p-3 text-[11px] leading-relaxed dark:border-zinc-700 dark:bg-zinc-950 ${mono ? "whitespace-pre-wrap font-mono" : "font-mono"}`}
      >
        {content}
      </pre>
    </details>
  );
}
