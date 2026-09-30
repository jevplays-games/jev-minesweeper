# Analytics reference

Version: `ms-analytics-1.1.0`. Implementation: `public/shared/analytics.js`. Generated structural index: `analytics-field-catalog.json`. Sample exports: `reports/sample/`.

## 1. Evidence and access

A report is reconstructed from a **sealed, verified server event replay**, not from browser claims. The shared implementation also analyzes explicitly labeled local offline fixtures, which have no official ranking authority. Both players are independently analyzed using their own boards.

Live displays contain only public progress, accepted command counts, status, and approved structured opponent evidence. Full layout structure, flag correctness, mine-based hindsight, and model calibration are never returned for an active match. The detailed endpoint is owner-only; an opaque match ID is not authorization. World standings reveal public Discord display names and aggregate ranked performance, not raw replays.

The synthetic sample uses two scripted local policies. It is regression material, not a human result or a live JEV evaluation. The machine-readable catalog indexes 423 normalized paths observed in that sample, including metadata, array members, counters, and distribution statistics. It is **not** a claim of 423 independent scientific metrics or a complete JSON Schema for every optional provider response.

## 2. Types, missing values, and populations

All ratios are fractions from 0 to 1 unless explicitly named otherwise. Milliseconds (`Ms`) are measured from the shared server start; `*At` metadata uses Unix milliseconds. Cell IDs are zero-based row-major; exported row and column coordinates are one-based. Durations and counts are numeric. Undefined rates, unobserved latencies, missing prices, and absent clear times use `null`. An empty count map means no recorded events of that class, not proof that all possible classes occurred zero times.

An **accepted action/command** is reveal, set flag, remove flag, or chord admitted by the engine. Starting, resignation, adjudication, and disconnect events are not counted as ordinary commands. Rejected requests are separate operational records. A network retry with the same request ID does not add a second command. Do not infer physical clicks, double-click attempts, eye movements, attention, motor speed, or thought processes from these values.

Post-game move classification uses the **highest bounded local solver** regardless of match difficulty. Its direct/subset deductions and completed exact enumeration are evidence about the visible position, not a peek at the hidden layout. Truth is used only after classification to evaluate outcomes and flag correctness. The 24-variable / 250,000-node budget is not an exhaustive proof search for every possible board.

## 3. Report envelope and configuration

`analyticsVersion` pins the field semantics. `matchId` identifies the owner-held match. `generatedFrom` states the evidence source. `metadata` contains creation/start/finish timestamps, competition key, scope, verification, rank eligibility, and reasons. `configuration` stores dimensions, mine count, preset, reasoning difficulty, model, policy and engine versions, one-second cadence, deadline, adjudication interval, and lateness tolerance.

`result` contains outcome/reason, terminal time, opening-only flag, each board status, revealed-safe totals, and **actual clear times only**. A loss, explosion, unfinished board, or abandonment does not fabricate a clear time.

`match.durationMs` is final adjudication time. `acceptedEvents` includes lifecycle events. `acceptedCommands` is the sum of both players' accepted action counts. `mineDensity = mines / all cells`. `independentLayouts` documents the two-board design; it does not claim identical logical difficulty.

## 4. Per-player action and outcome measures

The following are under `players.human` and `players.jev`.

| Field/group | Definition / denominator |
|---|---|
| `actions` | Count of accepted board commands, excluding opening and lifecycle commands |
| `reveals`, `flagsPlaced`, `flagsRemoved`, `chords` | Partition by action type; they sum to actions |
| `safeChords`, `unsafeChords` | Chords that did not / did reveal a mine; no clairvoyant preclassification |
| `correctFlagPlacements`, `incorrectFlagPlacements` | Placement events on mined / safe cells, evaluated after sealing; repeated placements count as repeated commands |
| `correctFlagsRemoved`, `incorrectFlagsRemoved` | Removal events on mined / safe cells |
| `safeCellsFromOpening` | Automatic safe-cell reveal from the protected initial coordinate |
| `safeCellsFromActions` | Sum of new safe-cell reveals produced by later commands |
| `zeroExpansionActions` | Reveal commands opening more than one safe cell |
| `zeroExpansionCells` | Extra cells beyond the chosen cell from those reveal commands; chord yields are separate |
| `revealedSafe`, `unrevealedSafeCells` | Final safe-cell totals; they sum to the board's safe-cell count |
| `safeCompletionRate` | Revealed safe cells / total safe cells |
| `status`, `terminalAtMs`, `activeMs` | Actual board status, time it cleared/exploded, and elapsed time until board terminal or match end |
| `clearMs` | Board terminal time only when cleared; otherwise null |
| `revealedMineCells`, `explodedCell` | Mine cells revealed and the explosion coordinate; available only post-game |
| `flagsAtEnd`, `correctFlagsAtEnd`, `incorrectFlagsAtEnd` | Final flags, split by hidden truth |
| `unflaggedMinesAtEnd` | Mine count minus correctly flagged mines |
| `flagPrecision` | Correct final flags / final flags; null with no flags |
| `flagRecall` | Correct final flags / mine count |
| `flagF1` | `2 × correct final flags / (final flags + mine count)` |
| `flagPlacementPrecision` | Correct placement commands / all placement commands |
| `flagChurn` | Number of flag-removal commands; not an inferred mental indecision score |
| `firstActionMs`, `lastActionMs` | First/last ordinary command time; null when none |
| `commandsPerSecond` | `actions × 1000 / activeMs`; null at zero duration |
| `safeCellsPerAction` | Safe cells gained after opening / accepted actions |
| `revealYield` | Distribution of safe-cell delta across **all commands**, including zero-yield flag changes |
| `inputGapMs` | Distribution of gaps between that player's accepted commands; first gap begins at game start |
| `maximumIdleGapMs`, `idleGapsOver2s/5s/10s` | Maximum observed pre-command gap and counts strictly greater than each threshold; trailing inactivity after the last command is not included |
| `threeBVPerSecondOnClear` | `static 3BV × 1000 / actual clear time`, only for actual nonzero-duration clears |

The two boards can have unequal opening reveals. Safe cells per action excludes those opening cells to avoid attributing them to later commands. Progress and race outcome still include the opening.

## 5. Risk, deductions, and alternatives

| Field/group | Meaning |
|---|---|
| `provenSafeRevealActions` | Reveals in the bounded solver's proven-safe set |
| `knownMineRevealActions` | Reveals in its proven-mine set |
| `uncertainRevealActions` | Reveals unresolved by this solver; not necessarily unavoidable guesses |
| `uncertainSurvivals`, `uncertainExplosions` | Outcomes of those unresolved reveals |
| `uncertainRevealsWhileProvenSafeAvailable` | Unresolved reveal when at least one unflagged proven-safe cell was available |
| `explodedWhileProvenSafeAvailable` | Explosion on any command while an unflagged proven-safe reveal existed |
| `uncertainRevealRate` | Unresolved reveals / all reveals |
| `uncertainRevealSurvivalRate` | Survived unresolved reveals / unresolved reveals |
| `proofCoverage` | (Proven-safe + proven-mine reveals) / all reveals |
| `exactRiskCoveredActions`, `exactRiskCoverage` | Reveals with proof/exact risk, as count and fraction of reveals |
| `exactChosenRisk` | Distribution of chosen mine probabilities with source proof or exact |
| `knownAlternativeRiskRegret` | Selected exact/proven mine probability minus the smallest known exact/proven probability, floored at zero; only available where selected risk is exact/proven |
| `frontierSize`, `largestComponent`, `provenSafeOptions` | Per-action distributions of unresolved frontier cells, largest connected component, and unflagged safe reveals |

Known-alternative regret compares the solver's known probabilities over hidden cells, not a claim that every alternative is a one-click legal reveal. A flagged safe alternative can require unflagging first. Unknown candidate probabilities are not filled in from partial enumeration. No optimality certificate, unavoidable-guess certificate, or causal diagnosis of human reasoning is implied.

Risk source labels:

- `proof`: established by logical constraints or the safe nature of a flag/unflag action.
- `exact`: completed component enumeration with compatible global mine placements weighted combinatorially.
- `model-estimate`: a validated JEV safety forecast converted to mine probability where the solver has no exact value.
- `heuristic`: a bounded fallback estimate, never described as an exact probability.

Flags are annotations; the solver does not assume a human flag is correct. An incomplete enumeration cannot produce an exact label merely because its partial search has not found a counterexample.

## 6. Heatmaps and board structure

`players.{actor}.heatmaps` contains arrays with one entry per row-major cell:

| Array | Meaning |
|---|---|
| `commands` | Number of accepted commands targeted at that cell |
| `revealAtMs` | First time the cell became revealed; opening cells are 0, never-revealed cells are null |
| `flagPlacements` | Count of flag placement commands at that cell |
| `uncertainReveals` | Count of unresolved reveal commands targeted at that cell |

The UI offers heatmap selection; the full arrays are exported. These are interaction maps, not eye-tracking or cursor-hover maps.

`boards.{actor}` provides width, height, cell/mine/safe counts, mine density, zero-cell count, an adjacency histogram indexed 0–8, zero-region count, opening-size distribution, isolated numbered cells, static 3BV, edge/corner mine counts, and opening coordinates.

A zero region is a connected component of zero-adjacent-mine cells with its neighboring safe boundary. Its opening size counts the union within that region; boundary cells shared by multiple regions can appear in multiple opening-size samples. `isolatedNumberCells` are numbered safe cells outside every zero-region opening. **Static 3BV = number of zero regions + isolated numbered cells.** This is the implemented layout-effort proxy, not a no-guess guarantee, human difficulty score, or competitive efficiency certification. Edge counts include corners; the corner count is a subset, not an additional disjoint population.

## 7. Race time series

`timeline` has a record after every event: sequence, time, actor, event type, each safe-cell total and board status, and signed human lead. Opening changes are at time zero. A chart displays this data with a table alternative.

`race.humanAheadMs`, `jevAheadMs`, and `tiedMs` integrate the stepwise progress lead between consecutive recorded events. They sum to match duration. `leadChanges` counts sign reversals ignoring intervening ties. `humanPeakLeadCells` / `jevPeakLeadCells` are maximum positive advantages. `humanLeadAreaCellMs` integrates `(human safe cells − opponent safe cells) × interval duration`; it is a descriptive quantity, not a ranking score.

## 8. JEV decision and service analytics

The `opponent` section is based on **decisions attached to applied actions**. `decisionJournal` retains their structured candidate surfaces and validated provider responses for replay. A request that finishes after a match seals may never be applied and is therefore not in this journal. Measured usage and costs must not be interpreted as an exhaustive provider billing ledger; the admin endpoint also explicitly reports successful/applied usage, not total invoices. A future provider-account billing reconciliation would be a separate source.

`decisions` counts applied opponent decisions. `sourceCounts`, `remoteDecisions`, `forcedDecisions`, and `localDecisions` partition their actual source. `fallbackDecisions` is distinct from normal no-key practice. `fallbackReasons` groups service degradation. `providerAttempts`, `providerStatusCounts`, `retryCount`, and `invalidResponseCount` summarize recorded HTTP attempts attached to those applied decisions. Provider schema failures, timeouts, authentication errors, rate limits, and overloads remain distinguishable.

Distribution groups include complete decision latency, provider-attempt latency, solver time, candidates, legal actions, solver search nodes, request bytes, and Choice confidence. `exactEnumerationRate` records completed enumeration divided by applied decisions; a forced local proof may not need enumeration. `solverCutoffReasons` reports disabled/component/node/no-solution reasons where present. `selectedRiskSource` keeps model estimates separate from proofs and exact arithmetic.

Provider records carry the decision ID, model/policy, observation hash/revision, bounded candidates, evidence, solver metrics, measured timings, request bytes, source/fallback/error, attempts, validated typed response, and selected candidate. Applied server decisions additionally record scheduled/applied timestamps and lag. These records are explanations/evidence generated for display, **not hidden chain-of-thought**.

### Safety calibration

Only valid Noul safety forecasts for reveal candidates are calibrated. A prediction `p` means probability of **no mine at the candidate cell**; ground truth `y` is 1 for safe and 0 for mine after sealing.

`calibration.selected` covers chosen evaluated reveal candidates. `calibration.allEvaluated` covers all evaluated reveal candidates, including unchosen cells. Repeated observations of the same cell remain repeated forecasts. They are correlated samples and are not independent evidence of model generalization.

- **Brier:** mean of `(p − y)²`.
- **Log loss:** mean of `−[y ln(p) + (1−y) ln(1−p)]`, with each logged probability clamped below at `10^-12` for numeric safety.
- **Reliability bins:** ten equal-width probability intervals; p=1 belongs to the final bin. Each bin reports count, prediction sum, safe outcomes, mean prediction, and observed frequency.
- **Expected calibration error:** sum over bins of `(bin count / all count) × |mean prediction − observed frequency|`.

Empty populations yield null scores and zero bin counts. No invented model probabilities appear for no-key local play. Choice/Score confidence measures answer-distribution concentration and is **never** substituted for safety probability.

### Usage and estimated cost

`tokenUsage` reports validated input/output tokens, measured attempts, and attempts without valid usage records. `estimatedCost.amount = measured input tokens / 1,000,000 × configured input price`. A blank price produces null. Currency is USD. No price is fetched at runtime; operators must configure and review it. Output pricing, unobserved/in-flight requests, account-specific terms, network charges, and hosting are not inferred. `usageComplete` only describes usage presence within the journal's observed attempts.

## 9. Operations and retention

`operations` counts audits, audit types, rejected action requests and reasons, idempotent retries, stream reconnects, scheduling misses, and observed API latency. Stream reconnect count is openings minus the first opening, not an inference about physical network outages. Timing covers server-observed handling, not browser-to-server round-trip time.

Gameplay reconstruction is deterministic. Operational aggregates are a snapshot when the report is first computed and cached. They do not automatically expand to include later reads/exports or requests that completed after the cache was written. Audits older than `RETENTION_DAYS` (default 30) are removed; late first-time reports can consequently have incomplete operational coverage. The sealed gameplay journal is retained until operator deletion. Audit retention must not be advertised as automatic player-data deletion.

The optional administrator endpoint returns aggregated result states, queue/active counts, 24-hour audit counts, applied decision latency/source, and successful applied token usage. It is bearer-protected and disabled with no admin token. It exposes no active layouts, names, IPs, session secrets, or OAuth tokens. It is JSON, not a separate administrator UI.

## 10. History and rankings

Aggregates include matches, non-void completed matches, voids, wins/losses/draws, actual clears, actual-clear rate, clear-time distribution, streaks, and verified-ranked count. Win rate uses wins / (wins + losses + draws); draws are not removed from the denominator. Both draws and losses reset streaks. Voids do not. Timing aggregates exclude non-clears.

Wilson intervals use z=1.959963984540054 with binary success defined as a match win; they are descriptive binomial intervals, not a guarantee against dependence, selection bias, or cheating. The interval is not used to rank players.

Profile filters include preset, difficulty, This Week/All Time, and all/ranked/practice. History can include retained historical competition keys; inspect each row's key before comparison. Standings restrict to the current **exact competition key** and require twenty eligible completed games in the selected scope/period. The key includes rules, solver policy, model, preset, difficulty, cadence, and lateness tolerance. Weekly boundaries are Monday 00:00 UTC.

## 11. Distribution convention

Every `distribution` has `count`, `sum`, `min`, `max`, `mean`, `p50`, `p90`, `p95`, `p99`, and `populationStdDev`. Non-finite/non-numeric values are excluded. Empty distributions have count/sum zero and other fields null. Percentiles linearly interpolate the sorted values at `(n−1) × p`; standard deviation divides by n, not n−1.

## 12. Exports and reconstruction

| Export | Contents | Live availability |
|---|---|---|
| Analytics JSON | Complete report including metric arrays, timeline, actions, decision evidence | Sealed, owner-only |
| Action CSV | One row per accepted command with classification and before/after measurements | Sealed, owner-only |
| Timeline CSV | One row per accepted lifecycle/action event | Sealed, owner-only |
| Event JSONL | Hash-chained recorded events and applied decisions | Sealed, owner-only |
| Replay JSON | Config/seeds/commitments/events/result sufficient for deterministic replay | Sealed, owner-only |
| History CSV | Own retained match rows and verification/eligibility | Own non-secret rows only |
| Own-profile JSON | Own identity, match summary rows, aggregates; no session secrets or active layouts | Authenticated owner/session |

CSV string values starting with formula-significant characters are prefixed with an apostrophe. Numeric negatives remain numeric. JSON numbers stay numbers; objects in CSV are JSON-encoded. Replay verification checks deterministic rules, commitments, event hashes, candidate generation, selected actions, and result. It is not a cryptographic attestation by an independent third party that the host was honest or that the player was unassisted.

Run `node scripts/sample-report.js` to regenerate the synthetic sample. Run `npm run verify -- reports/sample/replay.json` to check it without any provider connection.
