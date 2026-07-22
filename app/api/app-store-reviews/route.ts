import { NextResponse } from "next/server";
import {
  APP_STORE_REVIEW_COUNTRY,
  AppStoreReviewError,
  fetchAppStoreReviews
} from "@/lib/app-store-reviews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestBody = {
  appUrl?: unknown;
  maxPages?: unknown;
  limit?: unknown;
  delayMs?: unknown;
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

  if (typeof body.appUrl !== "string") {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "APP_STORE_URL_REQUIRED",
          message: "请输入 App Store 链接。"
        }
      },
      { status: 400 }
    );
  }

  try {
    const result = await fetchAppStoreReviews(body.appUrl, {
      maxPages: body.maxPages as number | undefined,
      limit: body.limit as number | undefined,
      delayMs: body.delayMs as number | undefined
    });

    return NextResponse.json({
      ok: true,
      ...result,
      country: APP_STORE_REVIEW_COUNTRY
    });
  } catch (error) {
    const reviewError =
      error instanceof AppStoreReviewError
        ? error
        : new AppStoreReviewError(
            error instanceof Error ? error.message : "评论采集失败。",
            "APP_STORE_REVIEW_FETCH_FAILED",
            500
          );

    return NextResponse.json(
      {
        ok: false,
        error: {
          code: reviewError.code,
          message: reviewError.message,
          details: reviewError.details
        }
      },
      { status: reviewError.statusCode }
    );
  }
}
