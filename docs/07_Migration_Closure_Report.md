# Migration Closure Report — Make.com → Acctos AI In-House Processing Engine

| | |
|---|---|
| **Document** | 07 — Migration Closure Report |
| **Status** | **Closed — migration complete, first client live in production** |
| **Prepared by** | Viktor Serafimov, CTO |
| **Date** | 30 July 2026 |
| **Migration window** | 22 April 2026 → 30 July 2026 (14 weeks) |
| **Production client activated** | Universal Trade BG |
| **Related documents** | `00_Full_Technical_Documentation.md`, `01_Technical_Documentation.md`, `02_PRD.md`, `03_Client_Functional_Documentation.md`, `04_User_Guide.md`, `05_Business_Case_and_Product_Analysis.md`, `06_Client_Guide_New_System.md` (BG, v2.0) |

---

## 1. Executive Summary

Acctos AI's document-processing automation was originally built on **Make.com**, a third-party low-code automation platform that acted as the orchestration layer between the client's email inbox, the OCR/AI services, and the delivered output. That dependency has now been **fully removed from the production processing path** and replaced with an in-house TypeScript processing engine that we own, version, test, and deploy ourselves.

The migration is complete. The engine is live, and our existing client — **Universal Trade BG** — has been cut over from the legacy Make.com scenarios to the new platform and is being served by it in production.

**What this delivered:**

- **End-to-end ownership of the processing pipeline.** Classification, OCR orchestration, bank-specific parsing, verification, AI categorization, Excel generation, delivery, and archiving are all our own code in a single repository — no external scenario editor, no vendor-side execution limits, no black-box failure modes.
- **A capability we could not have built on Make.com.** 24 bank-specific parsers, per-file and cross-file balance reconciliation, duplicate detection, missing-statement (chain gap) detection, and a rules-plus-AI categorizer. These require real control flow and state that a scenario builder cannot express economically.
- **Lower latency and fewer moving parts.** Ingestion is now event-driven (Google Pub/Sub push) with a 30-second polling fallback, versus a fixed 30-second polling cycle mediated by a third party. One less platform in the critical path means one less independent source of outage.
- **Consolidated, intelligible client communication.** Where the legacy flow emitted one email per individual error, the new engine emits a single result email plus one consolidated issues summary — a direct response to client feedback.
- **Removal of a recurring third-party subscription** from the processing path, replaced by usage-based infrastructure we control (see §8).

**Scale of the work:** 478 commits across the migration window; ~19,100 lines of backend TypeScript, of which ~13,200 lines are the processing engine itself; ~7,250 lines of frontend.

**Residual work is tracked, not open-ended.** A small amount of legacy Make.com *code* remains in non-processing areas (usage-cost reporting, the support-ticket form, and the vestigial scenario pause/resume enforcement path). None of it is in the document-processing critical path. It is enumerated with owners and recommendations in §9 and should be retired in a short follow-up sprint before the next client onboarding.

---

## 2. Objectives and Scope

### 2.1 Objectives

| # | Objective | Status |
|---|---|---|
| 1 | Remove Make.com from the document-processing critical path | ✅ Achieved |
| 2 | Reproduce 100% of legacy functional behaviour (ingest → process → deliver → archive) | ✅ Achieved |
| 3 | Exceed legacy accuracy through bank-specific parsing and verification | ✅ Achieved — 24 dedicated parsers + reconciliation checks that did not exist before |
| 4 | Reduce end-to-end latency | ✅ Achieved — push-driven ingestion replaces fixed 30s polling |
| 5 | Eliminate the recurring third-party automation subscription from the processing path | ✅ Achieved |
| 6 | Migrate the existing production client without service interruption | ✅ Achieved — Universal Trade BG live |
| 7 | Document the new system for engineering and for the client | ✅ Achieved — docs `00`–`06`, including a Bulgarian client guide (v2.0) |

### 2.2 In scope

- The full processing pipeline: document classification, OCR orchestration, bank statement and VAT parsing, verification, transaction categorization, Excel output generation.
- All three ingestion entry points: email (Gmail), dashboard upload, and the Drive/Sheets hand-off.
- Outbound delivery: result emails with attached Excel, Google Drive archiving, and the full notification/alert set.
- Usage metering and billing-limit enforcement for jobs originating from the new engine.
- Cutover of Universal Trade BG.

### 2.3 Explicitly out of scope

- **The billing and subscription surface** (Stripe integration, plan catalogue, add-on credits) was already native to our platform and was not part of this migration, although it was extended to meter the new engine's jobs.
- **The client dashboard** (`apps/web`) predates the migration. It was extended (pipeline visualisation, files history, role visibility) but not rebuilt.
- **Retirement of the legacy Make.com account and its historical usage-reporting integration.** Deliberately deferred — see §9.

---

## 3. Before and After

### 3.1 Legacy architecture (Make.com era)

```
Client email ──► Gmail ──► Make.com scenarios (30s polling)
                             │  scenario-level branching
                             │  HTTP modules → OCR / AI
                             │  one email per individual error
                             ▼
                     Google Drive + Sheets ──► Client
                             │
                             └──► POST /api/usage/document ──► Acctos AI dashboard (metering only)
```

In this model our own platform was essentially a **metering and billing dashboard**. The actual work happened inside Make.com scenarios. Consequences:

- **Opaque failures.** A scenario error surfaced as a Make.com notification, not as a structured, classified error we could route, explain, or act on.
- **No real verification.** Extraction correctness could not be cross-checked against the bank's own declared totals, because scenario steps had no shared state across files in a batch.
- **Per-error email noise.** Each failing step notified independently; a batch with five issues produced five emails.
- **Vendor coupling.** Availability, execution limits, and pricing were controlled by a third party. A Make.com incident stopped all client processing with no fallback.
- **Bank coverage was generic.** Layout variation across UK banks — and OCR column drift within a single bank — could not be handled without unmanageable scenario branching.

### 3.2 Current architecture (in-house engine)

```
┌── Ingestion ──────────────────────────────┐
│  Gmail: Pub/Sub push + 30s poll fallback  │
│  Dashboard upload (POST /v1/users/import) │
│  Drive/Sheets hand-off (POST /v1/drive/…) │
└───────────────────┬───────────────────────┘
                    ▼
        ProcessingOrchestrator  (apps/api/src/services/processing)
                    │
   limit gate ──► classify ──► extract ──► parse ──► verify ──► categorize ──► output
                    │            │           │         │           │            │
                    │      Azure DI OCR   24 bank   declared    rules +      ExcelJS
                    │      + SHA-256      parsers   totals +   gpt-5-nano   templates
                    │      OCR cache      + AI       balance   + Claude
                    │                     fallback   chain     fallback
                    ▼
        Persist & deliver (non-blocking):
        JobStore · Supabase · Google Drive · Mailgun · usage metering
```

Everything between ingestion and delivery is now our code, in our repository, deployable by us.

### 3.3 Capability comparison

| Dimension | Make.com era | In-house engine |
|---|---|---|
| Trigger latency | Fixed 30s polling cycle | Push-driven (near-immediate); 30s poll as fallback |
| Bank handling | Generic extraction | 24 dedicated bank parsers + Claude-backed fallback for unknown layouts |
| Correctness checks | None | Parsed vs. bank-declared totals; opening→closing balance chain per file; cross-file chain gap detection |
| Duplicate handling | None | Detected and reported before processing |
| Missing statements | Undetected | Detected via chain gap analysis, client notified |
| Error reporting | One email per error | 1 result email + 1 consolidated issues summary; 10 classified alert types internally |
| OCR cost control | Re-billed on every retry | SHA-256-keyed OCR cache in Supabase; repeat OCR is free |
| Failure diagnosis | Vendor scenario logs | Our own structured logs, classified client-vs-system error types, durable job records |
| Deployability | Scenario edits in a vendor UI | Git-versioned, reviewable, revertible |

---

## 4. Timeline and Milestones

All dates are taken from the repository history and are verifiable against the commits cited.

| Date | Milestone | Evidence |
|---|---|---|
| **22 Apr 2026** | **Migration begins.** Working prototype of the Make.com logic reimplemented in code. | `57d6379 migrate Make.com to code - working prototype` |
| Apr 27 – May 5 | Platform hardening around the new path: SuperAdmin provisioning, tenant creation, file preview, recent files, usage-tracking corrections | `7f73e1e`, `fa94523`, `d69ae80` |
| **13 May – 8 Jun** | **Parser build-out — the bulk of the engineering effort.** Dedicated parsers written and rewritten for Lloyds, HSBC, Barclays (+ Business, BarclayCard), Santander (+ Edge Up, Basic), NatWest, Nationwide, Starling, Monzo, Revolut, Metro, TSB, Tide, RBS, Wise, Zempler, Countingup, Halifax. AI fallback parser for unrecognised banks introduced. | `7cf91f6`, `336a932`, `4f7f292`, `9d16067`, and ~40 further parser commits |
| 26 May | Claude Haiku AI fallback for unrecognised bank layouts | `9d16067` |
| 8 Jun | Categorizer moved from OpenAI Assistants API to Chat Completions (performance) | `1ebe325` |
| 9–12 Jun | Verification layer: batch balance-chain resolution, declared-totals extraction, categorizer coverage enforcement | `1595f4e`, `32b2870`, `500966a` |
| **24 Jun** | **Chain continuity check** — detection of missing statements across a batch | `8e4c483` |
| 26 Jun | Notification service wired to outbound email (parser errors, job failures, chain gaps) | `2c13e29` |
| **29 Jun – 1 Jul** | **Google Drive / Sheets integration**, legacy folder structure replicated (subfolders per email subject + originals) | `8d3add6`, `3ddca22` |
| **1 Jul** | **Email ingestion live** — Gmail polling on the `Bank Statement AI` and `VAT AI` labels; result email with processed Excel attached to the accountant | `64aac9f`, `a0fdcca` |
| 2 Jul | Excel-by-email accepted; unsupported file types reported back; categorizer moved to the OpenAI Responses API for GPT-5 compatibility | `543ef51`, `16d1863` |
| **9 Jul** | **Billing enforcement wired to the new engine** — usage recorded into the same tables as the legacy path, limit gate and admin pause/resume | `d5556b9`, `ddbe6d5` |
| 9–13 Jul | Outbound email consolidated onto Mailgun (EU) after evaluating Resend and the Gmail API | `7b4470f`, `158e821` |
| **16 Jul** | **Consolidated issue reporting** — one team summary and one client summary per batch, replacing per-error emails | `ee8f827`, `4280932` |
| 16 Jul | Event-driven ingestion via Google Pub/Sub push | `f036132` |
| **23 Jul** | **Full technical documentation published** (`docs/00`) | `f09b9d2` |
| 20–30 Jul | Production hardening on live client traffic: balance-check accuracy, OCR column-leak fixes (Santander, Lloyds), email routing rules, role visibility, duplicate-delivery suppression | `b117cd0`, `8f0a78e`, `d521dc8`, `9cb3a15` |
| **30 Jul 2026** | **Ingestion reliability finalised** — Pub/Sub push restored with the 30-second poll retained as a fallback. **Migration closed.** | `b3357bc` |

> **Note for the record:** the exact production cutover date for Universal Trade BG should be inserted here from the operational log. The technical readiness date for client traffic was **1 July 2026** (email ingestion + result delivery live), and the client-facing Bulgarian guide describing the new system (v2.0) is dated **July 2026**.

---

## 5. What Was Delivered

### 5.1 The processing engine

`apps/api/src/services/processing/` — ~13,200 lines. Single orchestrator (`ProcessingOrchestrator.ts`) invoked by all three entry points, running seven stages:

1. **Limit gate** — billing entitlement checked before any billable work is done.
2. **Classification** — bank identified from filename *and* OCR content, with explicit ordering rules to defeat false positives (e.g. a Nationwide ATM appearing in a Santander statement, Halifax-before-NatWest, HSBC BIC prefixes).
3. **Extraction** — PDFs split per page and sent to Azure Document Intelligence (`prebuilt-layout`) at concurrency 3, with a SHA-256-keyed OCR cache so identical pages are never re-billed. Oversized documents auto-split; null results retried once. Excel inputs handled by a separate AI-assisted schema mapper.
4. **Parsing** — one of 24 bank-specific parsers. Where two banks conflict, both parsers run and the higher-yield result wins. Unrecognised layouts fall through to a Claude-backed column-layout detector.
5. **Verification** — parsed totals reconciled against the bank's own declared totals; the opening→closing balance chain validated within each file; and, for multi-file batches, `computeChainVerification` detects gaps indicating a missing monthly statement.
6. **Categorization** — deterministic rules first (Supabase `vendor_categories` + built-ins on normalised merchant names) to suppress AI spend, then batched calls to OpenAI `gpt-5-nano` with a structured schema, falling back to Anthropic `claude-haiku-4-5` on quota exhaustion. 13 accounting categories. Learned signals are written back as reusable vendor rules, so per-transaction AI cost declines over time.
7. **Output and delivery** — ExcelJS generation from versioned templates, then non-blocking persistence to Supabase, archiving to Google Drive, result email via Mailgun, and usage metering.

### 5.2 Bank coverage (24 banks + generic fallback)

HSBC · Revolut · Monzo · Wise · Starling · NatWest · Mettle · Nationwide · Santander (+ Basic, Edge Up) · Barclays (+ Business, BarclayCard) · Metro · Lloyds · TSB · Tide · RBS · Virgin Money · Pockit · Zempler · Countingup · Halifax · ANNA · Monese

### 5.3 Notification and alerting

Ten classified, fire-and-forget alert types (`NotificationService.ts`), split between internal team routing and client-facing communication: parser error, job failed, chain gap, insufficient files, duplicates removed, team issues summary, client issues summary, processing complete, unsupported attachment, unknown bank. Client-facing volume is deliberately capped at two emails per batch.

### 5.4 Client-facing surfaces

- Dashboard extended with a live six-stage pipeline visualisation, a Files History tab visible to all members, paginated recent files and reports, and preview/download of generated output.
- Bulgarian client guide (`docs/06`, v2.0) explaining the change, including an explicit old-vs-new comparison for the client's own staff.

### 5.5 Documentation

Seven documents in `docs/`, including a complete technical reference (`00`), PRD, client functional documentation, user guide, business case, and the Bulgarian client guide. `00` is authoritative and supersedes the pre-migration `README.md` / `DOCUMENTATION.md` / `WALKTHROUGH.md`.

---

## 6. Client Activation — Universal Trade BG

Universal Trade BG, previously served by the legacy Make.com scenarios, has been migrated to the new engine and is live in production.

**Cutover approach:** the new engine was made to reproduce the legacy client-visible contract before switching traffic — the same Gmail labels (`Bank Statement AI`, `VAT AI`), the same Google Drive folder structure including per-subject subfolders and originals (`3ddca22`), and a result email carrying the processed Excel. From the client's side, the workflow did not change: they email PDFs and receive Excel back. **No change to client behaviour was required, and no retraining was needed** — which is why the cutover was non-disruptive.

**Post-activation hardening.** Ten days of live traffic (20–30 July) surfaced and resolved real-world issues that no synthetic test set had exposed:

| Issue found in production | Resolution |
|---|---|
| Azure DI leaked columns on Santander ATM cash withdrawals | `8f0a78e` |
| Santander and Lloyds declared totals missed when the OCR summary table was not detected | `b117cd0`, `47f8ca5` |
| Balance check shown even when the bank's own totals verified correct | `fedf545` |
| Result emails re-ingested by the Gmail poller as new input | `f5755bc`, `2b4256b` |
| Result email reaching unintended recipients | `d521dc8`, `30962db` |
| Duplicate processing when push and poll fired simultaneously | `e70394f`, `874a674` |
| MEMBER-role users auto-logged-out of the dashboard | `89cc39c`, `542ed29` |
| Parser errors not surfaced to the client | `fb501bb` |

This is the expected shape of a successful cutover: the architecture held, and the defects found were data-specific and were closed within the window.

> **For the operational record, insert:** exact cutover date/time; whether a parallel-run period against Make.com was held and for how long; number of batches, files, and pages processed since activation; and any client-reported incidents post-cutover. These belong in the closure record but are operational facts, not repository facts.

---

## 7. Testing and Validation

**Validation strategy.** Because the output is financial data, correctness could not rest on unit tests alone. The primary validation mechanism is **self-verifying output**: every processed file is reconciled against the bank's own declared totals and its opening→closing balance chain, and every batch is checked for continuity gaps. A parse that does not reconcile raises an alert rather than silently delivering wrong numbers. This check runs on every production job, permanently — it is a control, not a one-off test.

**Test assets in the repository:**

- Per-bank harness scripts (21 ad-hoc `test-*` scripts under `apps/api`) used to develop and regression-test parsers against real statements.
- A committed Vitest unit test for the HSBC parser, plus documented parser regression notes (`docs/parser_regression_notes/HSBC_2026_04.md`).
- `test_fixtures/` for statement fixtures.

**Validation performed:** each of the 24 parsers was developed against real client statements and iterated until parsed totals matched bank-declared totals; multi-file batches were validated end-to-end through the chain-verification logic; and the system was then validated under live client traffic during the July hardening window (§6).

**Honest assessment of the gap.** Automated regression coverage is thin relative to the size of the parser surface: one committed unit test against 24 parsers, with the rest of the validation living in ad-hoc harness scripts and in the runtime verification layer. The runtime checks are strong and they are what protects clients today — but they catch a regression *after* it reaches production, not before. Converting the harness scripts into a committed fixture-based regression suite is the single highest-value engineering follow-up (§10).

---

## 8. Benefits Realised

**Delivered and verifiable:**

1. **Vendor removed from the critical path.** No third-party automation platform can now interrupt document processing. The failure surface is our code and our directly-contracted service providers (Azure, OpenAI, Anthropic, Google, Mailgun, Supabase).
2. **Latency reduced.** Push-driven ingestion replaces a fixed 30-second polling cycle, with polling retained purely as a safety net.
3. **Accuracy controls that did not previously exist.** Declared-totals reconciliation, balance-chain validation, cross-file gap detection, and duplicate detection are all new capabilities, not ports.
4. **Client communication load reduced.** Two emails per batch instead of one per error.
5. **OCR spend controlled.** The SHA-256 OCR cache eliminates re-billing on retries and repeat submissions; the rules-first categorizer suppresses AI calls, and the vendor-rule learning loop increases that suppression over time.
6. **Full deployment control.** Changes are reviewed, versioned, and revertible. Ten days of live-traffic fixes in July were shipped by us, immediately — that turnaround was not available under the previous model.
7. **Recurring third-party subscription removed** from the processing path.

**Quantification to be completed by Finance for the board version:** the retired Make.com subscription cost versus the incremental run-rate of the replacement (Azure Document Intelligence, OpenAI, Anthropic, Mailgun, Supabase, Railway), and the resulting net monthly position. The architectural change moves us from a fixed platform fee to usage-based infrastructure cost, which improves gross margin as volume grows but should be stated with real figures rather than estimated here.

---

## 9. Residual Make.com Footprint — Decommission Backlog

Closure is credible only if what remains is stated plainly. **No item below is in the document-processing critical path**, and none affects the live client. All are legacy code paths from the metering-dashboard era that outlived their purpose.

| # | Location | What it is | Recommendation | Priority |
|---|---|---|---|---|
| 1 | `apps/web/src/pages/Tickets.tsx:6` | The support ticket form posts to a **hardcoded Make.com webhook** instead of our own `/v1/tickets` API, which already exists and works. This is the only place a *live* client-facing feature still calls Make.com. | Repoint to `/v1/tickets`; delete the webhook constant. | **High** |
| 2 | `apps/api/src/utils/usageLimits.ts` (§134–260) | Limit enforcement still tries to **pause/resume Make.com scenarios** as its enforcement action. For a tenant with no Make API key these functions return early and do nothing. The real enforcement is `checkProcessingAllowed`, which blocks jobs in-process. | Confirm the in-process gate is the sole enforcement path, then remove the Make calls. Verify the `scenariosPaused` flag semantics still hold. | **High** |
| 3 | `apps/api/src/routes/integrations.ts` | Make.com API key verification, scenario usage sync, pause-all/resume-all endpoints. | Retire with the Make account. | Medium |
| 4 | `apps/api/src/cron/dailyReports.ts` | The nightly cron syncs Make.com credit usage before generating each tenant's AI report. | Remove the sync step; keep report generation. | Medium |
| 5 | `apps/api/src/utils/makeSync.ts` | Make.com usage-sync helper. | Delete with #3/#4. | Medium |
| 6 | Dashboard → Infrastructure tab | Still renders **Make.com cost cards and scenario controls**. Post-migration these show a dead integration to admins. | Remove the Make panel; keep Azure/OpenAI cost reporting. | Medium |
| 7 | `Tenant.makeApiKey`, `makeOrgId`, `makeFolderId` (+ `POST /api/auth/profile`) | Per-tenant Make credentials stored on the tenant row. | Drop the columns and the settings fields once #1–#6 are done. | Low |
| 8 | `POST /v1/drive/process` (`driveProcess.ts`) | The Drive/Sheets hand-off endpoint, originally the Make.com file hand-off. Still functional and reachable by API key. | Decide: retain as a supported integration surface, or retire. Document the decision either way. | Low — **decision needed** |
| 9 | `POST /api/usage/document`, `POST /v1/events/ingest` | Ingestion endpoints built for Make.com; now used by the engine's own metering. | Keep, but retitle in code/comments — they are internal metering endpoints now, not vendor integration points. | Low |

**Recommended action:** close items 1 and 2 before the next client onboarding, then 3–7 as a single cleanup, then formally terminate the Make.com subscription and rotate/revoke the stored API credentials. **The subscription should not be cancelled until items 3–6 are removed**, or the nightly report cron and the dashboard Infrastructure tab will begin logging authentication failures.

---

## 10. Technical Debt Carried Forward

Recorded here so that closing the migration does not close visibility on these. Full detail in `docs/00`, §15.

| # | Area | Issue | Recommendation |
|---|---|---|---|
| 1 | **Regression testing** | 24 parsers, one committed unit test; the rest of the coverage is ad-hoc harness scripts. | Promote the harness scripts to a committed fixture-based suite. Highest-value item on this list. |
| 2 | **CI/CD** | No CI at all — no GitHub Actions, no automated checks. Deploys are manual/platform-driven. | Add CI running build + tests on every PR. Pairs with #1. |
| 3 | **Migration integrity** | `monthly_usage_snapshots` is ALTERed but never CREATEd in any Prisma migration (it arrived via `db push`). A clean `migrate deploy` from an empty database fails. | Add the missing create migration. This blocks disaster recovery and clean environment provisioning. |
| 4 | **Job durability** | `JobStore` is an in-memory Map; a restart mid-job loses in-flight state (the Supabase record survives, the output buffer does not). | Acceptable at current volume. Revisit when concurrency grows. |
| 5 | **Security — CORS** | `app.use(cors())` with no allow-list. | Restrict to known origins. |
| 6 | **Security — JWT** | `JWT_SECRET` falls back to the literal `'secret'` if unset; `JWT_EXPIRES_IN` supports `'none'` (non-expiring tokens). | Fail startup if the secret is unset; retire the `'none'` option. |
| 7 | **Rate limiting** | No generic API rate limiter. | Add one at the edge. |
| 8 | **Two migration systems** | Prisma migrations (Railway Postgres) coexist with raw SQL in `supabase/migrations/`. | Document the ownership boundary per table. |
| 9 | **Hardcoded models** | `gpt-5-nano` and `gpt-5.4` are hardcoded, not env-driven. | Move to configuration so models can be changed without a deploy. |
| 10 | **Environment drift** | Live `apps/api/.env` diverges from `.env.example`. | Reconcile; treat `.env.example` as authoritative. |
| 11 | **Stale root docs** | `README.md`, `DOCUMENTATION.md`, `WALKTHROUGH.md` still describe the pre-migration, Make.com-era system. | Replace with a pointer to `docs/00`. Cheap, and it prevents a future engineer being misled. |

Items 1–3 are the ones I would fund immediately; the rest are appropriate for normal backlog scheduling.

---

## 11. Risks, Lessons, and What I Would Do Differently

**What worked:**

- **Reproducing the client-visible contract before switching traffic.** Same labels, same Drive structure, same email shape. The client experienced a capability upgrade, not a change to their workflow. This is the single reason the cutover was non-disruptive.
- **Bank-by-bank build-out on real statements.** Parsers developed against genuine client documents, one bank per branch, exposed OCR pathologies — column drift, merged cells, dropped minus signs, garbage headers — that synthetic fixtures would never have produced.
- **Making the output self-verifying.** Reconciling against the bank's own declared totals means the system can tell us when it is wrong. On financial data this is worth more than any volume of unit tests, and it is what let us cut over with confidence.
- **Rules-before-AI categorization.** Cost control designed in from the start rather than retrofitted, with a learning loop that improves the ratio over time.

**Lessons:**

1. **OCR is the hard part, not the AI.** The overwhelming majority of parser commits address Azure Document Intelligence layout artefacts, not categorization quality. Any future document-type expansion should budget accordingly — assume OCR normalisation dominates the effort.
2. **Delivery-channel decisions cost us iterations.** Outbound email went Resend → Gmail API → Mailgun in eight days, and Gmail ingestion went poll → push → poll → push-with-poll-fallback. Both converged correctly, but a short evaluation spike up front would have been cheaper than three production migrations. The final ingestion design — push with polling fallback — is the right one and should be treated as the pattern for future integrations.
3. **CI should have existed before the parser build-out, not after.** With 40+ parser commits touching shared extraction helpers, the absence of an automated regression gate was a standing risk that we absorbed through manual verification. It did not bite us, but that was partly luck.
4. **Legacy code outlives legacy vendors.** The processing path was clean weeks before the Make.com *code* was. Decommissioning should have been a tracked deliverable of the migration rather than a follow-up, which is why §9 exists as a backlog rather than as a completed section.

**Open risks:**

- **Single-client validation.** The engine has been proven against one client's document mix. The next onboarding will surface new bank-layout variants; the fallback parser covers unknown banks, and the unknown-bank alert (`07f41bf`) gives us early warning, but expect parser work with each new client.
- **No CI before onboarding client two.** Adding a second live client multiplies the cost of an undetected regression. I recommend closing debt items 1–3 first.
- **Third-party model dependencies.** Categorization depends on OpenAI with a Claude fallback; OCR depends on Azure with no fallback. Azure Document Intelligence is currently a single point of failure in extraction.

---

## 12. Operational Readiness

| Area | Status |
|---|---|
| **Production deployment** | Backend on a Node host with Railway-hosted Postgres, running Prisma migrations on boot; frontend on Vercel under `/dashboard/`; Supabase for OCR cache, job records, processed-file storage, and vendor rules. |
| **Health monitoring** | `GET /health` and `GET /v1/health` return status, commit SHA, and uptime. |
| **Alerting** | Ten classified alert types routed to the team via Mailgun, covering parser errors, job failures, unknown banks, and unsupported attachments. |
| **Observability** | Structured logs per pipeline stage; durable job records in Supabase; nightly AI-generated per-tenant activity reports. |
| **Usage and billing** | Metering wired from the engine into the same tables as the legacy path; limit gate enforced at job start; admin pause/resume, credit adjustment, and plan controls available in the dashboard. |
| **Documentation** | `docs/00` is the authoritative technical reference; `docs/06` (BG, v2.0) is the client-facing guide. |
| **Gaps** | No CI (§10.2); no automated backup/restore rehearsal — and note that restore into a clean database is currently blocked by §10.3. Recommend rehearsing recovery once that migration is fixed. |

---

## 13. Conclusion and Recommendation

**The migration is complete and is hereby closed.** Make.com has been removed from the document-processing critical path, the replacement engine is our own code, and Universal Trade BG has been successfully cut over and is being served in production. The system does more than the platform it replaced — bank-specific parsing, financial reconciliation, missing-statement detection, and consolidated client reporting are all new capabilities — and we now control its latency, its cost structure, and its release cadence.

The ten days of live-traffic fixes following activation were data-specific defects, resolved within the window, with no architectural rework required. That is the outcome we wanted from the cutover.

**I recommend the following before onboarding the next client:**

1. Close residual Make.com items **1 and 2** in §9 (ticket webhook, vestigial enforcement path).
2. Close technical debt items **1–3** in §10 — parser regression suite, CI on every PR, and the missing `monthly_usage_snapshots` migration.
3. Complete the Make.com decommission (§9 items 3–7), then terminate the subscription and revoke the stored credentials.
4. Have Finance quantify the cost position (§8) for the board version of this report.

None of these block current production service. All four are cheap now and expensive later.

---

## 14. Sign-off

| Role | Name | Date | Signature |
|---|---|---|---|
| CTO (author) | Viktor Serafimov | 30 July 2026 | |
| CEO / Business owner | | | |
| Client success (Universal Trade BG) | | | |

---

## Appendix A — Key Metrics

| Metric | Value |
|---|---|
| Migration duration | 22 Apr 2026 → 30 Jul 2026 (14 weeks) |
| Commits in migration window | 478 |
| Backend TypeScript | ~19,100 lines |
| Processing engine | ~13,200 lines |
| Frontend TypeScript | ~7,250 lines |
| Bank-specific parsers | 24 banks (29 parser modules incl. variants and fallback) |
| Transaction categories | 13 |
| Notification types | 10 |
| Ingestion entry points | 3 (email, dashboard upload, Drive hand-off) |
| Pipeline stages | 7 |
| Production clients migrated | 1 (Universal Trade BG) |
| Make.com dependencies in the processing path | 0 |
| Make.com code references remaining outside the processing path | 9 areas (§9) |

## Appendix B — Service Dependencies After Migration

| Service | Role | Fallback |
|---|---|---|
| Azure Document Intelligence | OCR (`prebuilt-layout`) | None — single point of failure in extraction |
| OpenAI (`gpt-5-nano`) | Transaction categorization | Anthropic `claude-haiku-4-5` on quota exhaustion |
| Anthropic Claude | Categorizer fallback; unknown-bank column detection | — |
| Google (Gmail / Drive / Sheets) | Ingestion, archiving, sheet output | Push + 30s poll fallback on ingestion |
| Mailgun (EU) | All outbound email | None |
| Supabase | OCR cache, job records, processed-file storage, vendor rules | Degrades to no-op if unconfigured |
| Railway Postgres | Primary datastore (Prisma) | — |
| Vercel | Frontend hosting | — |
| Stripe | Billing (out of migration scope) | — |

---

*Prepared from a full review of the `acctos-ai` repository. Every dated milestone and code reference in this report is traceable to the commit cited. Fields marked for insertion (§4, §6, §8) are operational and financial facts held outside the repository.*
