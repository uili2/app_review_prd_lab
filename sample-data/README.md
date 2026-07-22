# Sample Data And Offline Cache

This directory contains clearly marked offline demo files for reviewers who cannot access external networks during evaluation.

These files are not used by the application automatically. They do not replace live App Store RSS collection or model-driven analysis when network access and DashScope configuration are available.

## Files

| File | Purpose |
| --- | --- |
| `offline-reviews.sample.json` | JSON review import sample. Can be imported from the UI. |
| `offline-reviews.sample.csv` | CSV review import sample. Can be imported from the UI. |
| `offline-cache.sample.json` | Example cached analysis output snapshot for offline review. |

## Important Notice

- The sample review data is synthetic offline demo data.
- The cached output is marked with `cacheType: "offline-demo"` and `syntheticData: true`.
- Interviewers should use a new App Store link or their own JSON/CSV review dataset to verify that the system handles unseen inputs.
- The application code does not hard-code these sample conclusions.
- With valid network and model configuration, the system can collect fresh U.S. App Store RSS reviews and generate new findings, PRD, version plans, test cases, and traceability results.
