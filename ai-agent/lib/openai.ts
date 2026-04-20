import type { DecisionPrompts } from "./types";

const CHAT_URL = "https://api.openai.com/v1/chat/completions";

export type OpenAIChatResult =
  | { ok: true; content: string }
  | { ok: false; error: string; timedOut?: boolean };

function defaultTimeoutMs(): number {
  const raw = process.env.OPENAI_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 45_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 45_000;
}

function defaultModel(): string {
  return process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
}

/**
 * Calls OpenAI Chat Completions with JSON-oriented settings. Server-only.
 */
export async function completeDecisionChat(
  prompts: DecisionPrompts,
): Promise<OpenAIChatResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, error: "OPENAI_API_KEY is not set" };
  }

  const timeoutMs = defaultTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: defaultModel(),
        messages: [
          { role: "system", content: prompts.system },
          { role: "user", content: prompts.user },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    const rawJson: unknown = await res.json();

    if (!res.ok) {
      const msg =
        typeof rawJson === "object" &&
        rawJson !== null &&
        "error" in rawJson &&
        typeof (rawJson as { error?: { message?: string } }).error?.message ===
          "string"
          ? (rawJson as { error: { message: string } }).error.message
          : res.statusText;
      return { ok: false, error: msg };
    }

    const choices = (rawJson as { choices?: unknown }).choices;
    const first =
      Array.isArray(choices) && choices.length > 0 ? choices[0] : undefined;
    const content =
      first &&
      typeof first === "object" &&
      first !== null &&
      "message" in first &&
      typeof (first as { message?: { content?: unknown } }).message
        ?.content === "string"
        ? (first as { message: { content: string } }).message.content
        : undefined;

    if (!content?.trim()) {
      return { ok: false, error: "Empty model response" };
    }

    return { ok: true, content: content.trim() };
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      return {
        ok: false,
        error: `Request exceeded OPENAI_TIMEOUT_MS (${timeoutMs}ms)`,
        timedOut: true,
      };
    }
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Plain-text assistant reply after execute_notify (simulated calendar/email/inbox).
 * Server-only; no JSON response_format.
 */
export async function completeExecuteNotifyReply(
  system: string,
  user: string,
): Promise<OpenAIChatResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, error: "OPENAI_API_KEY is not set" };
  }

  const timeoutMs = defaultTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: defaultModel(),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.55,
        max_tokens: 700,
      }),
      signal: controller.signal,
    });

    const rawJson: unknown = await res.json();

    if (!res.ok) {
      const msg =
        typeof rawJson === "object" &&
        rawJson !== null &&
        "error" in rawJson &&
        typeof (rawJson as { error?: { message?: string } }).error?.message ===
          "string"
          ? (rawJson as { error: { message: string } }).error.message
          : res.statusText;
      return { ok: false, error: msg };
    }

    const choices = (rawJson as { choices?: unknown }).choices;
    const first =
      Array.isArray(choices) && choices.length > 0 ? choices[0] : undefined;
    const content =
      first &&
      typeof first === "object" &&
      first !== null &&
      "message" in first &&
      typeof (first as { message?: { content?: unknown } }).message
        ?.content === "string"
        ? (first as { message: { content: string } }).message.content
        : undefined;

    if (!content?.trim()) {
      return { ok: false, error: "Empty model response" };
    }

    return { ok: true, content: content.trim() };
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      return {
        ok: false,
        error: `Request exceeded OPENAI_TIMEOUT_MS (${timeoutMs}ms)`,
        timedOut: true,
      };
    }
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}
