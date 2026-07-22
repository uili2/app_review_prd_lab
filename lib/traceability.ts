export type TraceabilityStatus = "pass" | "warning" | "fail";

export type TraceabilityEntityType = "finding" | "requirement" | "testCase";

export type TraceabilityIssue = {
  id: string;
  status: TraceabilityStatus;
  entityType: TraceabilityEntityType;
  entityId: string;
  check: string;
  message: string;
  relatedIds: string[];
};

export type TraceabilitySummary = {
  status: TraceabilityStatus;
  total: number;
  pass: number;
  warning: number;
  fail: number;
};

export type TraceableReview = {
  id: string;
};

export type TraceableEvidenceQuote = {
  reviewId: string;
  quote?: string;
};

export type TraceableFinding = {
  findingId: string;
  supportingReviewIds?: string[];
  evidenceQuotes?: TraceableEvidenceQuote[];
  contradictionReviewIds?: string[];
  uncertainty?: string;
  assumption?: string;
};

export type TraceableRequirement = {
  requirementId: string;
  findingId: string;
  sourceReviewIds?: string[];
};

export type TraceableTestCase = {
  testCaseId: string;
  requirementId: string;
  sourceReviewIds?: string[];
};

export type ValidateTraceabilityInput = {
  reviews: TraceableReview[];
  findings: TraceableFinding[];
  requirements: TraceableRequirement[];
  testCases: TraceableTestCase[];
};

export type TraceabilityValidationResult = {
  summary: TraceabilitySummary;
  issues: TraceabilityIssue[];
};

export function validateTraceability(input: ValidateTraceabilityInput): TraceabilityValidationResult {
  const reviewIds = new Set(normalizeIds(input.reviews.map((review) => review.id)));
  const findingById = new Map(input.findings.map((finding) => [finding.findingId, finding]));
  const requirementById = new Map(input.requirements.map((requirement) => [requirement.requirementId, requirement]));
  const issues: TraceabilityIssue[] = [];

  const addIssue = (
    status: TraceabilityStatus,
    entityType: TraceabilityEntityType,
    entityId: string,
    check: string,
    message: string,
    relatedIds: string[] = []
  ) => {
    issues.push({
      id: `TV-${String(issues.length + 1).padStart(3, "0")}`,
      status,
      entityType,
      entityId,
      check,
      message,
      relatedIds: uniqueStrings(relatedIds)
    });
  };

  if (!input.findings.length) {
    addIssue("warning", "finding", "findings", "findings_present", "No findings were generated to validate.");
  }

  for (const finding of input.findings) {
    const entityId = finding.findingId || "(missing findingId)";
    const referencedReviewIds = getFindingReferencedReviewIds(finding);
    const missingReferencedReviewIds = difference(referencedReviewIds, reviewIds);

    if (missingReferencedReviewIds.length) {
      addIssue(
        "fail",
        "finding",
        entityId,
        "finding_review_ids_exist",
        "Finding references reviewId values that do not exist.",
        missingReferencedReviewIds
      );
    } else {
      addIssue(
        "pass",
        "finding",
        entityId,
        "finding_review_ids_exist",
        referencedReviewIds.length
          ? "All reviewId references in this finding exist."
          : "This finding does not reference reviewIds; evidence marking is checked separately.",
        referencedReviewIds
      );
    }

    const evidenceReviewIds = getFindingEvidenceReviewIds(finding);
    if (!evidenceReviewIds.length) {
      if (hasEvidenceCaveat(finding)) {
        addIssue(
          "warning",
          "finding",
          entityId,
          "finding_has_evidence_or_caveat",
          "Finding has no supporting evidence and is marked with uncertainty or assumption."
        );
      } else {
        addIssue(
          "fail",
          "finding",
          entityId,
          "finding_has_evidence_or_caveat",
          "Finding has no supporting evidence and is not marked with uncertainty or assumption."
        );
      }
    } else {
      addIssue(
        "pass",
        "finding",
        entityId,
        "finding_has_evidence_or_caveat",
        "Finding has explicit supporting review evidence.",
        evidenceReviewIds
      );
    }
  }

  for (const requirement of input.requirements) {
    const entityId = requirement.requirementId || "(missing requirementId)";
    const findingExists = Boolean(requirement.findingId && findingById.has(requirement.findingId));

    if (!requirement.findingId) {
      addIssue("fail", "requirement", entityId, "requirement_finding_id_exists", "Requirement is missing findingId.");
    } else if (!findingExists) {
      addIssue(
        "fail",
        "requirement",
        entityId,
        "requirement_finding_id_exists",
        "Requirement references a findingId that does not exist.",
        [requirement.findingId]
      );
    } else {
      addIssue(
        "pass",
        "requirement",
        entityId,
        "requirement_finding_id_exists",
        "Requirement references an existing findingId.",
        [requirement.findingId]
      );
    }

    const sourceReviewIds = normalizeIds(requirement.sourceReviewIds ?? []);
    const missingSourceReviewIds = difference(sourceReviewIds, reviewIds);

    if (!sourceReviewIds.length) {
      addIssue(
        "fail",
        "requirement",
        entityId,
        "requirement_source_review_ids_exist",
        "Requirement has no sourceReviewIds."
      );
    } else if (missingSourceReviewIds.length) {
      addIssue(
        "fail",
        "requirement",
        entityId,
        "requirement_source_review_ids_exist",
        "Requirement sourceReviewIds include reviewId values that do not exist.",
        missingSourceReviewIds
      );
    } else {
      addIssue(
        "pass",
        "requirement",
        entityId,
        "requirement_source_review_ids_exist",
        "All requirement sourceReviewIds exist.",
        sourceReviewIds
      );
    }

    if (findingExists && sourceReviewIds.length && !missingSourceReviewIds.length) {
      const finding = findingById.get(requirement.findingId);
      const findingEvidenceIds = new Set(finding ? getFindingEvidenceReviewIds(finding) : []);
      const idsOutsideFindingEvidence = sourceReviewIds.filter((reviewId) => !findingEvidenceIds.has(reviewId));

      if (findingEvidenceIds.size && idsOutsideFindingEvidence.length === sourceReviewIds.length) {
        addIssue(
          "warning",
          "requirement",
          entityId,
          "requirement_sources_trace_to_finding",
          "Requirement sourceReviewIds exist but do not overlap with the linked finding evidence.",
          sourceReviewIds
        );
      } else if (idsOutsideFindingEvidence.length) {
        addIssue(
          "warning",
          "requirement",
          entityId,
          "requirement_sources_trace_to_finding",
          "Some requirement sourceReviewIds are not part of the linked finding evidence.",
          idsOutsideFindingEvidence
        );
      } else {
        addIssue(
          "pass",
          "requirement",
          entityId,
          "requirement_sources_trace_to_finding",
          "Requirement sourceReviewIds trace back to the linked finding evidence.",
          sourceReviewIds
        );
      }
    }
  }

  for (const testCase of input.testCases) {
    const entityId = testCase.testCaseId || "(missing testCaseId)";
    const requirementExists = Boolean(testCase.requirementId && requirementById.has(testCase.requirementId));

    if (!testCase.requirementId) {
      addIssue("fail", "testCase", entityId, "test_case_requirement_id_exists", "Test case is missing requirementId.");
    } else if (!requirementExists) {
      addIssue(
        "fail",
        "testCase",
        entityId,
        "test_case_requirement_id_exists",
        "Test case references a requirementId that does not exist.",
        [testCase.requirementId]
      );
    } else {
      addIssue(
        "pass",
        "testCase",
        entityId,
        "test_case_requirement_id_exists",
        "Test case references an existing requirementId.",
        [testCase.requirementId]
      );
    }

    const sourceReviewIds = normalizeIds(testCase.sourceReviewIds ?? []);
    const missingSourceReviewIds = difference(sourceReviewIds, reviewIds);

    if (!sourceReviewIds.length) {
      addIssue("fail", "testCase", entityId, "test_case_source_review_ids_exist", "Test case has no sourceReviewIds.");
    } else if (missingSourceReviewIds.length) {
      addIssue(
        "fail",
        "testCase",
        entityId,
        "test_case_source_review_ids_exist",
        "Test case sourceReviewIds include reviewId values that do not exist.",
        missingSourceReviewIds
      );
    } else {
      addIssue(
        "pass",
        "testCase",
        entityId,
        "test_case_source_review_ids_exist",
        "All test case sourceReviewIds exist.",
        sourceReviewIds
      );
    }

    if (requirementExists && sourceReviewIds.length && !missingSourceReviewIds.length) {
      const requirement = requirementById.get(testCase.requirementId);
      const requirementSourceIds = new Set(normalizeIds(requirement?.sourceReviewIds ?? []));
      const overlappingIds = sourceReviewIds.filter((reviewId) => requirementSourceIds.has(reviewId));
      const idsOutsideRequirement = sourceReviewIds.filter((reviewId) => !requirementSourceIds.has(reviewId));

      if (!overlappingIds.length) {
        addIssue(
          "fail",
          "testCase",
          entityId,
          "test_case_sources_trace_to_requirement",
          "Test case sourceReviewIds do not trace to the linked requirement sourceReviewIds.",
          sourceReviewIds
        );
      } else if (idsOutsideRequirement.length) {
        addIssue(
          "warning",
          "testCase",
          entityId,
          "test_case_sources_trace_to_requirement",
          "Test case includes reviewIds outside the linked requirement sourceReviewIds.",
          idsOutsideRequirement
        );
      } else {
        addIssue(
          "pass",
          "testCase",
          entityId,
          "test_case_sources_trace_to_requirement",
          "Test case validates reviewIds from the linked requirement.",
          sourceReviewIds
        );
      }
    }
  }

  return {
    summary: summarizeIssues(issues),
    issues
  };
}

function summarizeIssues(issues: TraceabilityIssue[]): TraceabilitySummary {
  const summary: TraceabilitySummary = {
    status: "pass",
    total: issues.length,
    pass: 0,
    warning: 0,
    fail: 0
  };

  for (const issue of issues) {
    summary[issue.status] += 1;
  }

  if (summary.fail > 0) {
    summary.status = "fail";
  } else if (summary.warning > 0) {
    summary.status = "warning";
  }

  return summary;
}

function getFindingReferencedReviewIds(finding: TraceableFinding) {
  return uniqueStrings([
    ...normalizeIds(finding.supportingReviewIds ?? []),
    ...normalizeIds(finding.contradictionReviewIds ?? []),
    ...normalizeIds((finding.evidenceQuotes ?? []).map((quote) => quote.reviewId))
  ]);
}

function getFindingEvidenceReviewIds(finding: TraceableFinding) {
  return uniqueStrings([
    ...normalizeIds(finding.supportingReviewIds ?? []),
    ...normalizeIds((finding.evidenceQuotes ?? []).map((quote) => quote.reviewId))
  ]);
}

function hasEvidenceCaveat(finding: TraceableFinding) {
  return Boolean(normalizeText(finding.uncertainty) || normalizeText(finding.assumption));
}

function difference(values: string[], knownValues: Set<string>) {
  return values.filter((value) => !knownValues.has(value));
}

function normalizeIds(values: Array<string | null | undefined>) {
  return uniqueStrings(values.map((value) => normalizeText(value)).filter(Boolean));
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values));
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
