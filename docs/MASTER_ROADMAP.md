# Đông Phú Gia — Master Roadmap v1.8
Owner-approved 2026-11-27 · 120 decision IDs across seven rounds; v1.1 supersedes Linear governance in round 7 after Owner-accepted Jira connector pilot (DPG-1–DPG-4). Of the 104 decisions in rounds 1–6, v1.2 superseded 1.8, 4.14, 4.24 and 6.8 to preserve every phase record while deriving publication and SEO from the new IA. v1.3 applies Owner decisions D-D01–03 (inventory out of scope; discontinued catalogue retirement; existing price accepted) and amends 1.4, 3.4, 3.9, 3.13, 3.24, 4.14 and 6.8, plus the vision and the price/transaction wording in the acceptance boundaries; no decision ID is added or removed. [Owner decision v1.2](https://tranhuunguyenhuy.atlassian.net/browse/DPG-6?focusedCommentId=10027) · [Approved disposition](https://tranhuunguyenhuy.atlassian.net/browse/DPG-22?focusedCommentId=10032) · [Owner decision D-D01–03](https://tranhuunguyenhuy.atlassian.net/browse/DPG-25?focusedCommentId=10048) · [TL disposition](https://tranhuunguyenhuy.atlassian.net/browse/DPG-25?focusedCommentId=10046). v1.6 records Owner-approved D3 contextual discovery as a clarification without changing the decision IDs. v1.8 applies the Owner's complete design reset: all 20 former Round 5 decisions (5.1–5.20) and prior Project 04/05 design approvals are revoked as active requirements, with historical IDs retained solely for traceability. v1.5/v1.7 design content is historical only in [the prior revision](https://github.com/tranhuunguyenhuy-hue/dongphugia-web/blob/c5de4af742b270c1a39be70f58f621f15f62353f/docs/MASTER_ROADMAP.md); it is not a candidate or implementation baseline. [Owner reset](https://tranhuunguyenhuy.atlassian.net/browse/DPG-9?focusedCommentId=10268). Preserve the other 100 decision IDs and all accepted Project 00–03 rules; governance 7.1/7.2 below clarify the isolated Design Lab and revised checkpoint count. **Target direction, not deployed state or blanket authorization to implement.** V1 only. Project 00 authorized; no product-module kickoff before readiness. No V2. This stable contract is the versioned decision register; Jira will hold live tasks, checkpoints and progress after cutover. Do not maintain progress in this file.

## Design reset · Owner directive (v1.8)

No prior visual direction, UI framework choice, token, typography, color, component, pattern, screen, layout or earlier design approval is valid as an active design requirement or candidate. Rebuild from first principles using verified current product facts, accepted information architecture, customer journeys, business and data/security contracts (Projects 00–03), without prescribing the solution. New design decisions require the applicable scoped review and Owner acceptance. The existing runtime is unchanged; this document grants no implementation or release authority.

[DPG-48](https://tranhuunguyenhuy.atlassian.net/browse/DPG-48) is the accepted independent Design Lab infrastructure, not a design approval. Source: private [dongphugia-design](https://github.com/tranhuunguyenhuy-hue/dongphugia-design), HTML/CSS/JS, versioned source and Git auto-deploy from main to [design.dongphugia.vn](https://design.dongphugia.vn). Public link access is Owner-approved; noindex is not authentication; publish only public or synthetic non-sensitive material. Private handoff and approval records remain outside the published site, with Jira links and exact revision evidence. No additional budget or changes to commerce Production, Staging or CI/CD. ChatGPT directly leads design work; Codex only if separately assigned. Project 05 HOLD until both Project 03 and 04 acceptance and explicit Owner kickoff.

## D3 · Owner-approved contextual discovery (v1.6)

Owner approved D3 across all ten product groups on 2026-11-27; [original approval](https://tranhuunguyenhuy.atlassian.net/browse/DPG-34?focusedCommentId=10088), [design review and verification conditions](https://tranhuunguyenhuy.atlassian.net/browse/DPG-34?focusedCommentId=10098), [Owner acceptance](https://tranhuunguyenhuy.atlassian.net/browse/DPG-34?focusedCommentId=10099). This clarifies 2.3, 2.7–2.8, 2.13–2.14 and 4.5–4.12 without adding or replacing decision IDs.

- Preserve D1/D2 and the approved 10 groups / 48 assignable types. Each Product has one primary category by product nature. Technical attributes and evidenced relationships remain independently modeled and editable at their appropriate Product/SKU scope; do not force common attributes across unrelated types.
- Public discovery contexts may overlap and are derived from evidenced attributes/relationships within the applicable primary type(s); they are not a second taxonomy or exclusive enumeration. Context-specific filters and meaningful options depend on eligible, verified values, not names or SKU punctuation. Hide empty contexts and unsupported/redundant filters; selected zero-result or stale options remain removable. Do not automatically create navigation entries, category pages or indexable SEO landing pages.
- A context is an additional query constraint: OR within a facet, AND across facets and context on the same eligible discoverable SKU, with safe Product-level inheritance. Count distinct Products within context before pagination; representative SKU must match the query. Keep publication, discovery, Buy, RFQ and index eligibility separate. Brand, usable SKU price and verified series are shared where meaningful; no inventory facet or source-price reverification.
- For toilets, distinguish a manufacturer-integrated smart unit from a complete toilet sold with a separate electronic seat; standalone seats and replacement parts are distinct types. Preserve independent construction, mounting, cistern configuration, outlet, wash function and evidenced smart features; tankless does not imply integrated smart, nor vice versa. Do not infer configuration or feature values from marketing names or model punctuation.
- Preserve raw values, provenance and explicit unknown/none/not-applicable/invalid/conflict/candidate states. Candidate or conflicting facts do not qualify as verified public facet/context values. Developers own taxonomy and attribute/filter definitions; staff enter permitted business values. Exact context labels, options, order, coverage and menu placement are not approved by D3. The 03.4 design acceptance is not acceptance of source data, migration, physical schema, runtime behavior or independently reproduced tests; retain verification gates for 03.5–03.9 and implementation.

## BA-A1 · Owner-approved clarifications (v1.4)

The Owner approved the following clarifications to decisions 3.6, 3.11–3.12, 3.15–3.18 and 3.22–3.24 on 2026-11-27. Apply them to the transaction contracts in 4.15–4.19. [Acceptance record](https://tranhuunguyenhuy.atlassian.net/browse/DPG-31?focusedCommentId=10072)

| ID | Approved rule |
| --- | --- |
| BA1 | Combine a retail voucher with sale price only when the voucher program explicitly permits it. |
| BA2 | Reject a voucher exceeding the eligible merchandise subtotal; explain and allow customer review. No unapproved fee discount or negative total. |
| BA3 | One accept-enabled issued quote version per request; authorized staff sets explicit expiry within approved policy. An adjustment request alone does not invalidate the current offer; expiry, explicit withdrawal or replacement does. Show current terms clearly. |
| BA4 | Authorized staff commit complete quoted price, discounts, fees, total and terms within delegated scope. Assignment is not authorization; no invented approval tier or threshold. |
| BA5 | Authorized staff may record external acceptance only with evidence of the actual authorized customer, exact version/terms, affirmative action and time, and valid offer at processing. Late or uncertain evidence requires fresh acceptance of a valid offer. |
| BA6 | Approve the principle of one demonstrably available secure transaction channel with verified staff-assisted recovery where feasible. Original authorized session only until out-of-session ownership verification is proven. No particular channel/provider, budget, configuration or lifetime is approved or verified. |
| BA7 | Customer requests change/cancel; authorized staff assesses by transaction state. Material changes require explicit customer consent. Paid/in-flight/delivered and refund/return exceptions follow actual approved policy and auditable evidence. No automatic refund. |

Operational evidence for staff delegations, expiry defaults, fees, channel capability and return/refund policies remains pending.

## Vision and scope
Build a specialized sanitary-ware commerce website centered on products: discover, evaluate, order/request quotes and track transactions, with lean sustainable information, data, UX and operations. Preserve business continuity, identity and transaction history. Rebuild information architecture and SEO sitemap from first principles, not legacy SEO constraints. Preserve brand identity, selectively reuse V1. No ERP, compulsory customer account, default infrastructure expansion, inventory management or stock display, or automated shipping promises.

## Roadmap (one Jira project DPG; eight Epics)
Each roadmap project maps to one Jira Epic and owns its deliverable. No arbitrary dates. Checkpoints guide work, not automatic authorization. Create Jira Tasks/Subtasks just in time. IA and BA inform data and UX; design-system and data work can iterate with UX, then implement vertical slices; measure baseline before material changes. Project 03 technical pilot and Project 06 R0 share evidence, not duplicated implementation; Project 04 rebuilds design independently in Design Lab; no runtime migration or library selection is authorized.

| Epic / roadmap project | Checkpoints in intended order | Output |
| --- | --- | --- |
| 00 Project Governance & Foundation | Jira Workspace Setup; Master Roadmap & Decision Register; Jira–GitHub Handoff & Pilot; Agent Operating Instructions; Backlog Transition & Execution Readiness | Operating model verified |
| 01 Information Architecture | Information Audit; Product Taxonomy; Discovery Architecture; Page Inventory & Sitemap; URL & SEO Architecture; IA Acceptance | Approved IA |
| 02 Customer Journey & Business Analysis | Customer Journey Mapping; Discovery & Evaluation; Retail Commerce; Negotiated Commerce; Tracking & Staff Operations; Business Rules Acceptance | Approved flows/rules |
| 03 Product & Data Architecture | Current Data Audit; Product Domain Model; Catalogue Identity & Configuration Normalization; Attribute & Facet Architecture; Logical Data Architecture; Physical Schema & Security; API & Query Contracts; Migration Design & Mapping; Technical Pilot & Acceptance | Tested data/contracts/migration plan |
| 04 Design Strategy & Design System | Design Research & Requirements; Experience & Visual Direction; Representative Real-Screen Prototypes; Design Tokens; Component Library; Public & Admin Patterns; Design QA, Source Persistence & Handoff | Reusable design system derived from accepted screens; 04.0 Design Lab is separate prerequisite |
| 05 UX/UI Design (HOLD) | User Flows & Wireframes; Navigation & Search; Catalogue, Listing & Filters; PDP, Configuration & Comparison; Cart & Checkout; Quotation & Tracking; Homepage, Brand & Content; Admin Operations; Responsive Prototype, Usability/Accessibility Validation & Handoff | Approved editable module-level designs with state coverage and traceable acceptance; kickoff only after 03 and 04 acceptance plus explicit Owner authorization |
| 06 Modular Development & Release | R0 Technical Foundation; R1 Catalogue Foundation; R2 Product Discovery; R3 Product Evaluation; R4 Retail Commerce; R5 Negotiated Commerce; R6 Tracking & Operations; R7 Brand & Content; R8 Consolidation & Legacy Retirement | Operational product capabilities |
| 07 Growth & Optimization | Measurement Baseline; SEO Monitoring; UX & Conversion Analysis; Performance Optimization; Continuous Improvement | Evidence-based improvement |

R0–R8 are capability clusters, not mandatory separate deployments. R1 supplies identity, attributes, pricing and catalogue administration; R2 uses its query contracts, R3 its PDP/configuration; R4 and R5 depend on correct SKU eligibility and transaction contracts; R4 includes minimum order/payment/fulfillment operations; R5 includes staff quote/version handling; R6 completes tracking and operations; R7 depends on catalogue contracts, may advance independently when ready. Compare is not a first-release blocker. R8 handles residual legacy; retire earlier whenever safe. Preserve compatibility or group releases; old runtime must never consume an incompatible schema without an approved cutover. No kickoff based on milestone existence alone.

## Decision Register (120 historical IDs; 100 active non-design decisions)
Decision IDs retain the Owner-approved choices except Round 5, whose 20 IDs are revoked and reserved solely for historical traceability. RC/RB replace earlier choices. Summaries define direction, not physical schema or UI. Update by reviewed change with Owner approval for strategic/business changes; technical details can be decided within delegated scope.

### 1 — Product Vision & Business Scope (8)
- 1.1 C: Hybrid commerce: direct order and negotiated quotation, based on eligibility.
- 1.2 D: Whole discovery-to-purchase funnel; meaningful transactions and leads over traffic alone; baseline before numerical KPIs.
- 1.3 C: B2C primary, separate B2B/contractor flow where needed; shared catalogue.
- 1.4 C: Sanitary ware only; other industries excluded until Owner changes scope; preserve/archive valuable historical data. No irreversible deletion authority except the Owner-authorized retirement of discontinued catalogue records under 4.14 and 6.8; out-of-scope sectors are never deleted on that basis.
- 1.5 C: Reorganize Admin by business domain with public releases.
- 1.6 C: Selective V1 reuse and module rebuild, no independent V2.
- 1.7 B: Paid productivity tools only with Owner approval; default incremental infrastructure budget $0.
- 1.8 E: Keep the UI, database and page structure lean for discoverability, usability, integrity and maintenance. Design URLs and the sitemap from the new IA. Legacy rankings, index coverage, visibility rules, paths and redirects impose no design constraints. Handle old URLs for safe transition and business continuity, redirecting only where equivalence is verified.

### 2 — Information Architecture (14)
- 2.1 D: Product type primary; brand additional discovery.
- 2.2 C: Flexible depth where meaningful.
- 2.3 C: One primary category by product nature; other discovery sets via relations.
- 2.4 C: Independent brand entity and page, shared catalogue.
- 2.5 C: Verified series related to brand/products, discovery/filter and pages only with independent value; not variant group.
- 2.6 A: Search product/brand, no separate needs taxonomy.
- 2.7 C: Shared listing engine/components; contextual filter config/query/UI separated.
- 2.8 C: Stable category by nature, attributes as filters, landing pages only for independent value.
- 2.9 C: Grouped sitewide search products/category/brand/series/content; name/SKU/catalogue initially prioritized.
- 2.10 C: Supporting content connected to products/brands/groups; no complex CMS.
- 2.11 C: Stable canonical URL by entity type independent of taxonomy; index pages of independent value.
- 2.12 A: Developers manage structure.
- 2.13 A: Needs discovery through search/filter, no separate taxonomy/landing.
- 2.14 A: Developers own taxonomy/navigation/page/attribute/filter/URL/SEO definitions; staff own business data/values, articles, orders/quotes. Reference creation permissions to be specified.

### 3 — Customer Journey & Business Rules (24)
- 3.1 B: Exact SKU preferred; general results via listing/filter; no ambiguous auto-redirect.
- 3.2 B: Select actual SKU before cart/order; quick add only if unambiguous.
- 3.3 B: Compare comparable products with normalized attributes; favorites backlog; compare not first-release gate.
- 3.4 E: Add to cart continues shopping; order now bypasses cart for selected SKU/qty and preserves existing cart; both require an existing usable price under 4.14. Separate negotiated quote CTA; unpriced eligible SKU quote-only; final copy deferred.
- 3.5 B: Unified cart, order or RFQ by eligibility.
- 3.6 A: Regular/list, promotional/sale, fixed online voucher (apply once in retail cart/checkout); derived final price; negotiated price separate, no automatic voucher.
- 3.7 C: Guest only, contact per transaction; staff auth remains.
- 3.8 A: One-page checkout.
- 3.9 B: Receipt records pending staff confirmation of fees and transaction details, not confirmed order; no separate stock-check gate.
- 3.10 B: COD or transfer/QR, no complex gateway; proof before paid.
- 3.11 B: Structured RFQ SKU/quantity, staff quote versions/expiry; no ERP/B2B accounts.
- 3.12 B: Accepted specific quote version converts to one order; staff may record acceptance evidence.
- 3.13 A: Inventory is out of scope: no stock quantity or status display, inventory integration, stock verification or automated shipping commitment. Legacy stock_status is not an availability rule; staff handle transaction processing.
- 3.14 B: Separate order/payment/fulfillment/quote lifecycles, not workflow engine.
- 3.15 B: Secure private tracking URL/ownership verification, revocation, no indexing or code-only lookup.
- 3.16 B: Key milestone notifications through approved channels, not all updates/marketing.
- 3.17 B: Customer may request change/cancel; staff/system resolve by state; no transaction deletion.
- 3.18 B: Admin operational queues, roles and history; not generic CRUD/ERP.
- 3.19 A: RFQ available to any eligible customer, no minimum quantity, no guaranteed discount.
- 3.20 A: Select eligible cart subset for order or selected items for RFQ; preserve unselected; no auto split; unpriced selection disables order. Direct RFQ for unpriced; UX for aggregating unpriced needs pending, no invented purchase CTA.
- 3.21 B: Optional desired price per SKU, quantity mandatory.
- 3.22 B: Private quote URL to view versions/accept/request adjustments; staff records external negotiation, no real-time chat.
- 3.23 B: Revalidate before submit and snapshot; subsequent changes require notification/acceptance; no voucher on accepted quote.
- 3.24 B: Staff confirms full costs and transaction details before transfer/QR instructions; COD delivery; proof before paid.

### 4 — Product & Data Architecture (24)
- 4.1 RC: Functional Product-centric architecture: meaningful function/install differences are separate Products; 1:N exact SKU, including singleton.
- 4.2 B: Model is a business identifier of Product or SKU, separate entity only if justified.
- 4.3 B: Group by verified manufacturer/function/attributes; insufficient evidence stays separate.
- 4.4 B: Immutable internal IDs; business identifiers and slugs unique under appropriate rules, not primary identity.
- 4.5 B: One primary category and brand, optional verified series; independent relations.
- 4.6 B: Distinguish variants, compatibility, accessories and transactable packages with evidence.
- 4.7 B: Typed attribute definitions, scope and unit.
- 4.8 C: Common Product attributes and explicit SKU overrides/inheritance.
- 4.9 B: Normalize typed values/units/options; provenance; distinguish unknown, none and not applicable.
- 4.10 RB: One card per Product in a result; representative eligible SKU matches context.
- 4.11 B: Same eligible SKU must satisfy all SKU filters; OR within facet, AND across; count Products.
- 4.12 B: Shared catalogue query/API contract; measured need before read model/external index.
- 4.13 B: Price on SKU; derived representative/range at Product, no independently edited product price.
- 4.14 B: Every retained record in the target plan is Active regardless of legacy active/inactive status. Records with an explicit discontinued status are retired under 6.8, not retained. Define publication, discovery, sale, quote and index eligibility separately under the new business rules; Active alone establishes none of them. An existing usable positive retail unit price on a retained eligible SKU is accepted as its initial sale price without further source verification; provenance is kept as audit metadata and the legacy contact/unknown price-state flag does not block it. Zero, null, invalid or non-price values are unpriced (quote-only if independently RFQ-eligible); never use zero for an unknown price. Normalize price fields deterministically by list, sale and promotional semantics; never invent a price, treat a reference-only value as a sale price without a rule, or discount twice. Unresolved contradictory amounts are data exceptions to resolve before use. Server-side validation at submit remains (3.23, 4.15).
- 4.15 B: Guest cart local/session preferred; server authoritative SKU, price and eligibility revalidation; persistence only as needed.
- 4.16 B: Order and Quotation separate entities/lines/snapshots/lifecycles; link accepted version.
- 4.17 B: Transaction snapshots, immutable sent quote versions and meaningful change history; no global Event Sourcing.
- 4.18 B: Contact per transaction; optional internal link only reliable and purposeful; no automatic identity merge.
- 4.19 B: Backend/DB authorization for public/private/admin, least privilege and audit.
- 4.20 B: Product/SKU content and media at appropriate level; references and provenance/rights as needed.
- 4.21 B: Relational core, structured JSONB when apt, measured denormalization.
- 4.22 B: Target independent of legacy; inventory/map/clean, real TEST pilot, phased reconciliation and safe retirement.
- 4.23 B: PDP switches related Products and concrete SKUs; update identity, URL, image/spec/price/eligibility consistently.
- 4.24 B: Audit all records of each phase’s brands across legacy statuses before regroup migration, starting with TOTO and INAX. Audit the remaining brands before final synchronization. Verify in-scope Product identity, functional and installation differences, or explicitly adjudicate exceptions before regrouping or publication. Do not blindly convert current variant groups. Exact SKU search preselects the verified SKU. Preserve historical IDs and SKUs and never fabricate combinations.

### 5 — Design Strategy & Design System (20 retired IDs; no active design decisions)
All prior Round 5 decisions revoked by Owner reset; do not consult their original content as current design authority. New decisions will be created only after scoped research and acceptance.
- 5.1 REVOKED — historical ID only.
- 5.2 REVOKED — historical ID only.
- 5.3 REVOKED — historical ID only.
- 5.4 REVOKED — historical ID only.
- 5.5 REVOKED — historical ID only.
- 5.6 REVOKED — historical ID only.
- 5.7 REVOKED — historical ID only.
- 5.8 REVOKED — historical ID only.
- 5.9 REVOKED — historical ID only.
- 5.10 REVOKED — historical ID only.
- 5.11 REVOKED — historical ID only.
- 5.12 REVOKED — historical ID only.
- 5.13 REVOKED — historical ID only.
- 5.14 REVOKED — historical ID only.
- 5.15 REVOKED — historical ID only.
- 5.16 REVOKED — historical ID only.
- 5.17 REVOKED — historical ID only.
- 5.18 REVOKED — historical ID only.
- 5.19 REVOKED — historical ID only.
- 5.20 REVOKED — historical ID only.

### 6 — Development & Release Strategy (14)
- 6.1 B: Modular monolith, combined Worker, clear domains.
- 6.2 B: Selective reuse; keep/refactor/rebuild/retire based on benefit.
- 6.3 B: Existing Cloudflare, Supabase TEST/Production, Bunny; incremental infra $0 absent explicit approval.
- 6.4 B: Lock cross-module contracts; just-in-time detailed scope/design/acceptance.
- 6.5 B: Vertical slices; foundation → catalogue → discovery → PDP → retail → negotiated → tracking → content; adapt dependency order.
- 6.6 B: Capability-based release, group tight dependencies, no forced release per PR.
- 6.7 B: Expand–Migrate–Switch–Contract preferred; approved maintenance cutover if compatibility/capacity prevents.
- 6.8 B: Normalize TOTO and INAX first, including every record and converting legacy inactive to target Active in the migration plan, except records with an explicit discontinued status. Owner authorizes the business policy of deleting those from the database, starting in this phase; only unambiguous cases qualify, and inactive status, missing price, a name signal or an out-of-scope sector never equals discontinued. Deletion runs only through the controlled release lane: exact reviewed ID list, dependency and consumer checks including transaction references, recoverable backup and restore, TEST rehearsal and reconciliation, Owner destructive STEP-GO and Production GO. Preserve raw audit and recovery evidence, transaction snapshots and history, and retained products; no broad cascade, no transaction deletion. Select phase brands by verified ID and keep the architecture extensible. Retain other brands’ data and defer their synchronization to the final rollout phase. Preserve data, provenance and history. Retain sector and D2 conflicts for explicit scope review under 1.4. Reconcile each phase before safe cutover under 4.22 and the existing release gates.
- 6.9 B: One authoritative reader/writer per datum/phase; reconcile delta writes; explicit cutover.
- 6.10 B: Prefer uninterrupted service; Owner-approved scoped maintenance window if needed.
- 6.11 B: Risk-based QA, required gates remain; integration and E2E appropriate to risks.
- 6.12 B: Agent self-review/test/merge within existing gates; Owner design/UAT/GO/cost/destructive authority.
- 6.13 RB: Aggressive retirement as soon as verified replacement, no consumers, reconciled preservation, feasible recovery and required destructive approval; no arbitrary wait. Worker rollback != SQL rollback.
- 6.14 B: Baseline/per-module performance budget; fix material regressions/quota risks, defer nonblocking optimization.

### 7 — Project Governance & Jira + GitHub (16)
- 7.1 v1.8: One existing Jira software project DPG; one V1 application repository and the separately approved private Design Lab repository (DPG-48), no application split.
- 7.2 v1.8: Eight Epics (00–07), 56 roadmap checkpoints after Project 04 reset, plus separate 04.0 Design Lab prerequisite; create tasks just in time, no artificial dates or plan upgrade.
- 7.3 v1.1: Create checkpoint Tasks/Subtasks just in time; no bulk future backlog.
- 7.4 v1.1: Native Jira Backlog → Ready → In Progress → In Review → Acceptance → Done, skipping irrelevant stages; canceled/duplicate terminal with reason. Until configured, To Do covers Backlog/Ready and In Review plus explicit acceptance-pending label distinguishes Owner acceptance; never mark Done before required acceptance.
- 7.5 B: TL priority by dependencies, business value and risk; deadlines only grounded.
- 7.6 v1.1: Native Jira Blocks links; explicit blocker and resolver, Owner Decision when needed.
- 7.7 v1.1: Minimal labels and views: Master Roadmap, Active Work, Owner Decisions, Blocked & Risks. Exclude governance-pilot evidence from active roadmap.
- 7.8 B: Default Claude infra/data/backend/ops/docs; Codex frontend/design/UI; authorized cross-lane/full-stack as needed.
- 7.9 B: One active execution task by default; parallel only independent and Owner-approved; no unauthorized agent/session.
- 7.10 B: TL plans, prioritizes, creates tasks, coordinates, selects agent/reviews within approved roadmap; Owner strategic/business/design/UAT/cost/Production authority.
- 7.11 v1.1: Jira-first work management; GitHub engineering and release authority. Link-only task/PR or explicit scoped GitHub execution handoff when agent Jira access is unavailable. No bidirectional issue sync, historical mass import, custom sync or new infrastructure.
- 7.12 v1.1: Link GitHub technical evidence; no auto-Done on merge or automated acceptance. Direct Owner release approval only in existing GitHub release route.
- 7.13 B: Event-driven short evidence-linked reports, no daily duplication.
- 7.14 B: Versioned decision register, rationale and Owner-approved strategic changes.
- 7.15 v1.1: AGENTS.md single policy; PROJECT.md technical handbook; this stable roadmap/decisions; Jira live scope/priority/dependencies/progress/acceptance after readiness.
- 7.16 v1.1: Governance setup, backlog reconciliation, reviewed docs, safe agent handoff and Owner readiness acceptance before kickoff.

## Acceptance, security and integration boundaries
New design choices, schema, exact migration and library decisions remain to be validated; no automatic authority to execute hosted writes. Price and transaction state come from existing source fields under 4.14, never invented; no manufacturer or retailer re-verification is required. All previous runtime safety and identity/slug contracts apply until specific approved replacement; historical order snapshots and IDs persist. TEST uses public/synthetic data, never customer PII. Maintain least privilege, rollback/forward recovery and exact candidate evidence. No production mutations authorized here.

Jira will own scope, priorities, dependencies and acceptance; GitHub remains authoritative for code, PR/CI, live release evidence and direct Owner approvals. While Project 00 is not accepted, retain existing authorized GitHub execution routes; no independent duplicated backlog. After cutover, engineering work links its Jira identifier/URL and GitHub PR; if an agent cannot access Jira, Tech Lead supplies one scoped linked GitHub handoff, not a second work authority. Only direct GitHub release issues/comments count for release gates. No bidirectional issue sync, copied release commands, auto-close on merge, automatic deployment, or custom integration service. Preserve release runbooks unchanged. Freeze unrelated merges during exact-SHA full release. UAT on locked SHA and Owner GO as existing pipeline requires. #511 hosted isolated SQL pilot passed; multi-batch hosted/function/worker/full Production chain remains unverified until relevant release. No CI/CD changes needed for this roadmap.

Readiness: verify Jira project, permissions, status mapping, plan/cost constraints and link-only handoff; exclude pilot evidence from roadmap views; reconcile legacy backlog without deleting/closing active release evidence; publish reviewed governance docs; verify agent receives task + contracts and reports evidence through one route; define next IA task. Product development starts only after Owner readiness acceptance.
