# Source and implementation notes

External documentation reviewed on **September22,2026**. These references support integration boundaries and deployment choices; the application's rules variant, analytics definitions, tests, benchmarks, code and screenshots are generated implementation artifacts, not claims made by the providers. No full external documentation or proprietary SDK is redistributed.

| Source | Use in this project |
|---|---|
| [TypeSafe API reference](https://docs.typesafe.ai/api) | Direct HTTP request/response contract, typed question fields, usage, service error handling |
| [TypeSafe model documentation](https://docs.typesafe.ai/models) | Pinned model identifier and documented model limits; prices are not hardcoded into analytics |
| [Noul](https://docs.typesafe.ai/primitives/noul) | Safety-forecast probability primitive |
| [Score](https://docs.typesafe.ai/primitives/score) | Ordered continuation rubric and response structure |
| [Choice](https://docs.typesafe.ai/primitives/choice) | Finite action preference and probability distribution |
| [Confidence](https://docs.typesafe.ai/confidence) | Distinction between distribution confidence and safety probability |
| [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2) | Authorization code flow, identify scope, commands-only installation, operator client-credential command registration |
| [Discord application commands](https://docs.discord.com/developers/interactions/application-commands) | /jev registration/upsert and guild context settings |
| [Discord interactions overview](https://docs.discord.com/developers/interactions/overview) | Signed HTTP interaction verification and response behavior |
| [Discord receiving/responding](https://docs.discord.com/developers/interactions/receiving-and-responding) | Interaction user/guild/channel data and private responses |
| [Node release schedule](https://nodejs.org/en/about/previous-releases) | Node24 LTS deployment target; actual tested runtime is separately recorded |
| [Node24 SQLite documentation](https://nodejs.org/docs/latest-v24.x/api/sqlite.html) | Native database API; tested22 runtime has different experimental-status labeling |
| [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) | Free-plan budget: 10 ms CPU, 128 MB, 50 subrequests/queries per invocation, 100 k requests/day, 500 MB per D1 database (fetched 2026-09-30; D1 daily row allowances are from the pricing page and were not re-fetched) |
| [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) | Session/cookie lifecycle design reference, not a certification |

## User-supplied basis

`original-request.md` is an unchanged copy of the uploaded JEV single-page game architecture prompt. The user's follow-up requested an implementation ZIP with exhaustive analytics. The implementation preserves the two-board variant and separates server trust from client presentation. Differences from the earlier proposed plan are documented: built-in SQLite instead of a third-party package, opaque fragment launch tickets instead of JWTs, three board presets included, comprehensive analytic modules, and no production SDK dependencies.

## Measurement evidence

`reports/tests.tap` and `reports/coverage.txt` contain executed Node test output. `reports/browser/` contains the measured Chromium DOM-bridge report and screenshots; it is not evidence of a normally navigating browser's live OAuth or native SSE behavior. Node tests separately exercise native HTTP/SSE. `reports/benchmark/` records deterministic local-policy measurements only. `reports/sample/` is a labeled scripted regression fixture, never an actual player record or live JEV benchmark.

No real Discord or TypeSafe credentials were supplied or used. No image/font assets were fetched from the sources above. Model capability, production latency and successful third-party authorization remain unverified until the operator runs staging checks.
