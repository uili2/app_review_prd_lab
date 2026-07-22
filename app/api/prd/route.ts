import { NextResponse } from "next/server";
import { ModelPrdError, generatePrdWithModel } from "@/lib/model-prd";
import type { Review } from "@/lib/reviews";
import type { ModelFinding } from "@/lib/model-findings";
import type { PrdRequirementInput } from "@/lib/model-prd";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestBody = {
  appName?: unknown;
  analysisGoal?: unknown;
  cleanedReviews?: unknown;
  findings?: unknown;
  requirements?: unknown;
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

  if (!Array.isArray(body.cleanedReviews) || !Array.isArray(body.findings) || !Array.isArray(body.requirements)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INVALID_PRD_INPUT",
          message: "请求体必须包含 cleanedReviews、findings、requirements 三个数组。"
        }
      },
      { status: 400 }
    );
  }

  try {
    const result = await generatePrdWithModel({
      appName: typeof body.appName === "string" ? body.appName : "Unknown App",
      analysisGoal: typeof body.analysisGoal === "string" ? body.analysisGoal : "",
      cleanedReviews: body.cleanedReviews as Review[],
      findings: body.findings as ModelFinding[],
      requirements: body.requirements as PrdRequirementInput[]
    });

    return NextResponse.json({
      ok: true,
      prdMarkdown: result.prdMarkdown,
      meta: {
        provider: result.provider,
        model: result.model,
        requirementCount: result.requirementCount,
        findingCount: result.findingCount,
        sourceReviewCount: result.sourceReviewCount,
        validation: result.validation
      }
    });
  } catch (error) {
    const prdError =
      error instanceof ModelPrdError
        ? error
        : new ModelPrdError(
            error instanceof Error ? error.message : "PRD 生成失败。",
            "MODEL_PRD_FAILED",
            500
          );

    return NextResponse.json(
      {
        ok: false,
        error: {
          code: prdError.code,
          message: prdError.message,
          details: prdError.details
        }
      },
      { status: prdError.statusCode }
    );
  }
}
