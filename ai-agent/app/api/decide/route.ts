import { NextResponse } from "next/server";
import { runDecisionPipeline } from "@/lib/decision-engine";
import type { DecideRequestBody } from "@/lib/types";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as DecideRequestBody;

    const tiers = ["low", "medium", "high"] as const;
    if (
      !body?.proposedAction?.summary?.trim() ||
      !body?.proposedAction?.danger_tier ||
      !tiers.includes(body.proposedAction.danger_tier as (typeof tiers)[number])
    ) {
      return NextResponse.json(
        {
          error:
            "proposedAction.summary and proposedAction.danger_tier (low | medium | high) are required.",
        },
        { status: 400 },
      );
    }

    if (!Array.isArray(body.conversationHistory)) {
      return NextResponse.json(
        { error: "conversationHistory must be an array." },
        { status: 400 },
      );
    }

    const trace = await runDecisionPipeline({
      ...body,
      userState: body.userState ?? {},
      llmInstructions: body.llmInstructions?.trim() || undefined,
      simulateFailure: body.simulateFailure ?? "none",
    });

    return NextResponse.json(trace);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
