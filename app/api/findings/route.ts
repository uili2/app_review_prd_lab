import { NextResponse } from "next/server";
import {
  ModelFindingsError,
  discoverFindingsWithModel
} from "@/lib/model-findings";
import type { Review } from "@/lib/reviews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestBody = {
  cleanedReviews?: unknown;
  analysisGoal?: unknown;
};

export async function POST(request: Request) {
  let body: RequestBody;

  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INVALID_JSON",
          message: "请求体必须是有效 JSON。"
        }
      },
      { status: 400 }
    );
  }

  if (!Array.isArray(body.cleanedReviews)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "CLEANED_REVIEWS_REQUIRED",
          message: "请求体必须包含 cleanedReviews 数组。"
        }
      },
      { status: 400 }
    );
  }

  try {
    const result = await discoverFindingsWithModel(
      body.cleanedReviews as Review[],
      typeof body.analysisGoal === "string" ? body.analysisGoal : ""
    );

    return NextResponse.json({
      ok: true,
      findings: result.findings,
      corrections: result.corrections,
      meta: {
        provider: result.provider,
        model: result.model,
        inputReviewCount: result.inputReviewCount,
        analyzedReviewCount: result.analyzedReviewCount,
        truncated: result.truncated
      }
    });
  } catch (error) {
    const findingsError =
      error instanceof ModelFindingsError
        ? error
        : new ModelFindingsError(
            error instanceof Error ? error.message : "动态主题发现失败。",
            "MODEL_FINDINGS_FAILED",
            500
          );

    return NextResponse.json(
      {
        ok: false,
        error: {
          code: findingsError.code,
          message: findingsError.message,
          details: findingsError.details
        }
      },
      { status: findingsError.statusCode }
    );
  }
}
