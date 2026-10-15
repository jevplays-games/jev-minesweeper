# SafeSweep benchmark

Generated 2026-10-14T22:32:50.623Z. Runtime v24.15.0.

**LOCAL BASELINES ONLY. No live TypeSafe/Jev calls were made.**

Same seeds and opening for each standalone policy. Independent-board race pairs swap seed allocation. One action = 1000 logical ms; compute/service latency reported separately.

Seed namespace: `heldout-ms-v1`. Board preset: `expert`.

| Policy | Boards | Clears | Clear rate | Invalid | Fallback | Decision p95 (ms) |
|---|---:|---:|---:|---:|---:|---:|
| random | 40 | 0 | 0.0% | 0 | 0 | 0.01 |
| easy-local | 40 | 2 | 5.0% | 0 | 0 | 0.24 |
| normal-local | 40 | 8 | 20.0% | 0 | 0 | 1.01 |
| hard-local | 40 | 13 | 32.5% | 0 | 0 | 1.25 |
| jev-local | 40 | 16 | 40.0% | 0 | 0 | 1.42 |

See summary.json for Wilson intervals, actual clear-only logical times, and swapped independent-board race results. runs.jsonl and traces.jsonl retain every measured game and selected action.

## Limitations
- Local policy results are NOT live Jev results.
- This is an implementation baseline, not proof of human-level ability or an externally certified benchmark.
- Seed set is deterministic and tunable; do not tune on this held-out namespace and then call it held-out.
- Remote failures remain in the results and are counted as fallback; remote calls may incur charges.
- Latency depends on this host and run; logical race time deliberately excludes it.
