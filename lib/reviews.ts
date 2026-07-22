export type ReviewSource = "rss" | "json" | "csv";

export type Review = {
  id: string;
  reviewId?: string;
  title: string;
  body: string;
  rating: number | null;
  version: string;
  updatedAt: string;
  date: string;
  author: string;
  country: string;
  sourceRow: number;
  source: ReviewSource;
  appId?: string;
  page?: number;
  sourceUrl?: string;
  externalId?: string;
};

export type ReviewImportSource = "json" | "csv";

export type ReviewImportStats = {
  rawCount: number;
  cleanedCount: number;
  removedEmptyCount: number;
  duplicateCount: number;
};

export type ReviewImportResult = {
  rawReviews: Review[];
  cleanedReviews: Review[];
  stats: ReviewImportStats;
};

type ReviewMeta = {
  appId?: string;
  country?: string;
  page?: number;
  sourceUrl?: string;
};

const ID_KEYS = ["reviewid", "review_id", "id", "评论id", "评论ID"];
const TITLE_KEYS = ["title", "reviewtitle", "review_title", "subject", "标题", "评论标题"];
const BODY_KEYS = [
  "body",
  "content",
  "review",
  "text",
  "comment",
  "description",
  "评论",
  "评论内容",
  "内容"
];
const RATING_KEYS = ["rating", "score", "stars", "star", "imrating", "评分", "星级"];
const VERSION_KEYS = ["version", "appversion", "app_version", "imversion", "版本", "应用版本"];
const UPDATED_AT_KEYS = [
  "updatedat",
  "updated_at",
  "updated",
  "date",
  "createdat",
  "created_at",
  "time",
  "日期",
  "时间"
];
const AUTHOR_KEYS = ["author", "user", "username", "nickname", "name", "用户", "昵称"];
const COUNTRY_KEYS = ["country", "locale", "region", "国家", "地区"];

export function parseReviewsFromText(
  text: string,
  source: ReviewImportSource,
  meta: ReviewMeta = {}
): ReviewImportResult {
  if (source === "csv") {
    return prepareReviews(parseCsvReviewRows(text, meta), "csv");
  }

  const parsed = JSON.parse(text) as unknown;
  if (isRssPayload(parsed)) {
    return prepareReviews(reviewsFromRssPayload(parsed, meta), "rss");
  }

  return prepareReviews(parseJsonReviewRows(parsed, meta), "json");
}

export function prepareReviews(reviews: Review[], source: ReviewSource): ReviewImportResult {
  const rawReviews = reviews.map((review, index) => normalizeReview(review, source, index));
  const cleanedReviews: Review[] = [];
  const seen = new Set<string>();
  let removedEmptyCount = 0;
  let duplicateCount = 0;

  for (const review of rawReviews) {
    const cleaned = {
      ...review,
      title: cleanText(review.title),
      body: cleanText(review.body),
      version: normalizeVersion(review.version),
      updatedAt: normalizeUpdatedAt(review.updatedAt || review.date),
      date: normalizeUpdatedAt(review.updatedAt || review.date)
    };

    if (!cleaned.title && !cleaned.body) {
      removedEmptyCount += 1;
      continue;
    }

    const dedupeKeys = getDedupeKeys(cleaned);
    if (dedupeKeys.some((key) => seen.has(key))) {
      duplicateCount += 1;
      continue;
    }

    dedupeKeys.forEach((key) => seen.add(key));
    cleanedReviews.push({
      ...cleaned,
      sourceRow: cleanedReviews.length + 1
    });
  }

  return {
    rawReviews,
    cleanedReviews,
    stats: {
      rawCount: rawReviews.length,
      cleanedCount: cleanedReviews.length,
      removedEmptyCount,
      duplicateCount
    }
  };
}

export function reviewsFromRssPayload(payload: unknown, meta: ReviewMeta = {}): Review[] {
  const feed = isRecord(payload) && isRecord(payload.feed) ? payload.feed : null;
  if (!feed) {
    throw new Error("RSS JSON 缺少 feed。");
  }

  return toArray(feed.entry)
    .filter(isRssReviewEntry)
    .map((entry, index) => reviewFromRssEntry(entry, index, meta));
}

function parseJsonReviewRows(parsed: unknown, meta: ReviewMeta): Review[] {
  const rows = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.reviews)
      ? parsed.reviews
      : isRecord(parsed) && Array.isArray(parsed.data)
        ? parsed.data
        : isRecord(parsed) && Array.isArray(parsed.items)
          ? parsed.items
          : null;

  if (!rows) {
    throw new Error("JSON 须为数组，或包含 reviews/data/items 数组。");
  }

  return rows
    .filter(isRecord)
    .map((record, index) => reviewFromRecord(record, "json", index, meta));
}

function parseCsvReviewRows(text: string, meta: ReviewMeta): Review[] {
  const rows = parseCsvRows(text).filter((row) => row.some((cell) => cell.trim()));
  if (rows.length < 2) {
    throw new Error("CSV 至少需要表头和一行数据。");
  }

  const headers = rows[0].map((header, index) => normalizeKey(header) || `column_${index + 1}`);
  return rows.slice(1).map((row, rowIndex) => {
    const record = headers.reduce<Record<string, unknown>>((nextRecord, header, columnIndex) => {
      nextRecord[header] = row[columnIndex] ?? "";
      return nextRecord;
    }, {});

    return reviewFromRecord(record, "csv", rowIndex, meta);
  });
}

function reviewFromRecord(
  record: Record<string, unknown>,
  source: ReviewSource,
  index: number,
  meta: ReviewMeta
): Review {
  const reviewId = pickString(record, ID_KEYS);
  const title = pickString(record, TITLE_KEYS);
  const body = pickString(record, BODY_KEYS);
  const rating = normalizeRating(pickString(record, RATING_KEYS));
  const version = normalizeVersion(pickString(record, VERSION_KEYS));
  const updatedAt = normalizeUpdatedAt(pickString(record, UPDATED_AT_KEYS));
  const author = pickString(record, AUTHOR_KEYS);
  const country = pickString(record, COUNTRY_KEYS) || meta.country || "";
  const id = reviewId || stableReviewId(source, { title, body, rating, version, updatedAt, author, country });

  return {
    id,
    reviewId: reviewId || undefined,
    externalId: reviewId || undefined,
    title,
    body,
    rating,
    version,
    updatedAt,
    date: updatedAt,
    author,
    country,
    sourceRow: index + 1,
    source,
    appId: meta.appId,
    page: meta.page,
    sourceUrl: meta.sourceUrl
  };
}

function reviewFromRssEntry(entry: Record<string, unknown>, index: number, meta: ReviewMeta): Review {
  const reviewId = fieldLabel(entry, "id");
  const title = fieldLabel(entry, "title");
  const body = fieldLabel(entry, "content");
  const rating = normalizeRating(fieldLabel(entry, "im:rating"));
  const version = normalizeVersion(fieldLabel(entry, "im:version"));
  const updatedAt = normalizeUpdatedAt(fieldLabel(entry, "updated"));
  const author = nestedFieldLabel(entry, ["author", "name"]);
  const country = meta.country || "us";
  const id =
    reviewId || stableReviewId("rss", { title, body, rating, version, updatedAt, author, country });

  return {
    id,
    reviewId: reviewId || undefined,
    externalId: reviewId || undefined,
    title,
    body,
    rating,
    version,
    updatedAt,
    date: updatedAt,
    author,
    country,
    sourceRow: index + 1,
    source: "rss",
    appId: meta.appId,
    page: meta.page,
    sourceUrl: meta.sourceUrl
  };
}

function normalizeReview(review: Review, source: ReviewSource, index: number): Review {
  const rating = normalizeRating(review.rating);
  const version = normalizeVersion(review.version);
  const updatedAt = normalizeUpdatedAt(review.updatedAt || review.date);
  const title = normalizeCell(review.title);
  const body = normalizeCell(review.body);
  const author = normalizeCell(review.author);
  const country = normalizeCell(review.country);
  const reviewId = normalizeCell(review.reviewId || review.externalId || "");
  const id =
    normalizeCell(review.id) ||
    reviewId ||
    stableReviewId(source, { title, body, rating, version, updatedAt, author, country });

  return {
    ...review,
    id,
    reviewId: reviewId || undefined,
    externalId: review.externalId || reviewId || undefined,
    title,
    body,
    rating,
    version,
    updatedAt,
    date: updatedAt,
    author,
    country,
    source,
    sourceRow: index + 1
  };
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  rows.push(row);
  return rows;
}

function isRssPayload(value: unknown) {
  return isRecord(value) && isRecord(value.feed) && value.feed.entry !== undefined;
}

function isRssReviewEntry(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Boolean(fieldLabel(value, "im:rating")) &&
    Boolean(fieldLabel(value, "content") || fieldLabel(value, "title"))
  );
}

function pickString(record: Record<string, unknown>, keys: string[]) {
  const normalized = Object.entries(record).reduce<Record<string, unknown>>((map, [key, value]) => {
    map[normalizeKey(key)] = value;
    return map;
  }, {});

  for (const key of keys) {
    const value = normalized[normalizeKey(key)];
    if (value !== undefined && value !== null) {
      return normalizeCell(value);
    }
  }

  return "";
}

function fieldLabel(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value === undefined || value === null) {
    return "";
  }

  if (isRecord(value) && value.label !== undefined && value.label !== null) {
    return normalizeCell(value.label);
  }

  return normalizeCell(value);
}

function nestedFieldLabel(record: Record<string, unknown>, path: string[]) {
  let current: unknown = record;

  for (const part of path) {
    if (!isRecord(current)) {
      return "";
    }
    current = current[part];
  }

  if (isRecord(current) && current.label !== undefined && current.label !== null) {
    return normalizeCell(current.label);
  }

  return normalizeCell(current);
}

function normalizeRating(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const match = String(value).match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }

  const rating = Number.parseFloat(match[0]);
  return Number.isFinite(rating) ? Math.max(0, Math.min(5, rating)) : null;
}

function normalizeVersion(value: unknown) {
  return normalizeCell(value)
    .replace(/^version\s*/i, "")
    .replace(/^v(?=\d)/i, "");
}

function normalizeUpdatedAt(value: unknown) {
  const text = normalizeCell(value);
  if (!text) {
    return "";
  }

  const timestamp = Date.parse(text);
  if (Number.isNaN(timestamp)) {
    return text;
  }

  return new Date(timestamp).toISOString();
}

function cleanText(value: string) {
  return normalizeCell(value).replace(/\s+/g, " ").trim();
}

function normalizeCell(value: unknown) {
  return String(value ?? "").replace(/\u0000/g, "").trim();
}

function getDedupeKeys(review: Review) {
  const contentKey = stableHash(
    [
      review.source,
      review.appId ?? "",
      review.title.toLowerCase(),
      review.body.toLowerCase(),
      review.rating ?? "",
      review.version.toLowerCase(),
      review.updatedAt,
      review.author.toLowerCase(),
      review.country.toLowerCase()
    ].join("\u001f")
  );

  return [review.reviewId, review.externalId, contentKey].filter(Boolean) as string[];
}

function stableReviewId(
  source: ReviewSource,
  review: Pick<Review, "title" | "body" | "rating" | "version" | "updatedAt" | "author" | "country">
) {
  const fingerprint = [
    source,
    review.title.toLowerCase(),
    review.body.toLowerCase(),
    review.rating ?? "",
    review.version.toLowerCase(),
    review.updatedAt,
    review.author.toLowerCase(),
    review.country.toLowerCase()
  ].join("\u001f");

  return `${source.toUpperCase()}-${stableHash(fingerprint)}`;
}

function stableHash(value: string) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36).padStart(7, "0");
}

function normalizeKey(key: string) {
  return key.toLowerCase().replace(/[\s_\-./:]/g, "");
}

function toArray(value: unknown) {
  if (Array.isArray(value)) {
    return value;
  }

  return value ? [value] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
