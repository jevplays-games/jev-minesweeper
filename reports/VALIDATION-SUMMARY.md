# Delivery validation summary

Date:2026-09-22. Source and evidence are bundled; this is not an external certification.

| Check | Result |
|---|---|
| Node unit/integration suite | 141/141 passed; zero failed/skipped |
| Runtime actually executed | Node22.16.0; built-in SQLite available, experimental warning |
| Native server HTTP/SSE | Owner snapshot, ownership rejection, CSRF and static-boundary tests passed |
| Chromium UI | Five workflows passed with no uncaught JS errors through explicit DOM/API bridge |
| Browser limitation | Normal URL navigation blocked by runner policy; direct-browser cookie/CSP/SSE/OAuth still requires staging validation |
| Deterministic local benchmark | 500 runs on100 seeds and5 local policies; no invalid moves; no live provider calls |
| Synthetic replay |24-event fixture verified; fourteen scripted human commands and eight local-opponent commands |
| SQLite backup | Consistent snapshot and integrity check passed locally; private backup not included |
| Static assets |41,434 gzip bytes for public/shared files including optional modules |
| TypeSafe live credentials | Not supplied; mocks and explicit local fallback tested |
| Discord live application | Not configured; OAuth mocks and actual cryptographic signature fixtures tested |
| Deployment | Templates included; public TLS, Docker image build and production host not deployed |

Detailed evidence: tests.tap, coverage.txt, browser/browser-results.json, benchmark/, sample/, static-footprint.json. Runtime databases, session cookies, secrets, private backup files, downloaded dependencies and font files are excluded from the archive.
