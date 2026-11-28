# Real Estate Due Diligence

`/lab/real-estate-due-diligence` is a full-viewport San José property catchment and buyer due-diligence workbench (accessible from the top-nav **Labs** hub at `/lab`) inspired by [Yehya’s Pillar reel](https://www.instagram.com/yehya_cre/reel/DgNtEF-pEcp/), the five `@noi.cre` AI real-estate research reels, and the Cloudflare architecture archived in [`baladithyab/realestate-dd`](https://github.com/baladithyab/realestate-dd/tree/archive/cloudflare-architecture-2026-07-04).

All interactive labs share `src/layouts/LabLayout.astro` (a `100dvh`, zero-outer-scroll app shell with a 48 px utility bar linking back to `/lab`) and are cataloged in `src/lib/labs.ts` for `/lab`.

Add up to five destinations with a map click, preset, address search, or coordinates. Right-click a pin or use its Remove button. Use **All points** to intersect drive areas and **Any point** to unite them. The workbench shows estimated residents, households, and renter share for cumulative 5-, 10-, and 15-minute drive areas. Points must be inside the dashed rectangle. Address search sends the query and study bounds to [Photon](https://github.com/komoot/photon).

## Interactive Map Selection, Popover & Listing Modal

When live listings or a local CSV are loaded, matching listings appear as interactive dots on the drive-time map:

- **Direct map or sidebar selection:** Click any listing in the **Listings** list or click its dot directly on the map canvas (hit-tested within 14 px before placing a new destination pin). The selected listing dot renders on top with a prominent highlight halo and contrast ring.
- **Anchored map popover:** Selecting a listing opens a Zillow-style popover card anchored directly to that listing’s map pin (auto-clamped inside the viewport and flipped above/below the pin as needed), displaying price/rent, status, address, beds/sq ft, modeled drive-time summary, and a **Saved due diligence report ready** badge when a 24-hour snapshot already exists.
- **Full Listing Details & Due Diligence modal:** Clicking the map popover (or **Inspect listing & due diligence** in the sidebar) opens a modal combining:
  - **External portal & area links** (all opening in a new tab): direct **Source listing** (when present), **Zillow**, **Redfin**, **Homes.com**, **Realtor.com**, **Google Maps**, and **SpotCrime** (`listingExternalLinks()` in `src/lib/site-study-listings.ts`).
  - **Listing details & modeled drive times** to every selected destination.
  - **Embedded Property Due Diligence report** (`SiteStudyPropertyReport`), automatically displaying an existing saved 24-hour snapshot (or session report) without re-fetching, or allowing the buyer to run live public-record checks and save the report directly from the modal while staying synced with the sidebar **Due diligence** tab.

## Drive-time & Census model

The model snaps destinations to the closest local road within 400 m and follows the directed OpenStreetMap graph in reverse to estimate drives **to** each destination. It uses road-class speeds capped by posted limits where available, samples reachable non-freeway roads onto a 250 m grid, and adds a short local-access allowance based on distance to each cell center. Turn restrictions, live traffic, conditional access, and routing outside the snapshot are outside the model.

The 2026 Census Planning Database supplies 2020–2024 American Community Survey estimates of population and owner- and renter-occupied units distributed across grid cells by overlap with each tract’s land-clipped geometry.

## Property data & HomeHarvest

Choose **Load live listings** to pull a sample of up to 40 sale and 40 rental listings for San José through a same-account service binding to a private Python Worker (`workers/homeharvest`, pinning HomeHarvest 2.1.0). Successful samples are cached per type for 15 minutes at each Cloudflare location and rate-limited on refreshes. You can also import a local CSV (`latitude`/`longitude`, HomeHarvest or generic `address`/`price`/`beds`/`sqft` columns) parsed entirely in the browser tab.

## Live Multi-Domain Property Due Diligence (`/api/lab/real-estate-due-diligence/evidence`)

Select any matching listing, choose **Open due diligence**, and click **Generate property report**. The Cloudflare Worker queries **seven live, keyless public-record domains** in two parallel stages, caching each domain independently in the Cloudflare Edge Cache API for 24 hours so partial failures can be retried without repeating healthy lookups:

| Domain | Live Keyless Source(s) | What is returned | Guardrails & Caveats |
| --- | --- | --- | --- |
| **1. Parcel & Identity** | [Santa Clara County `SCCProperty/MapServer/0`](https://maps.santaclaracounty.gov/server/rest/services/property/SCCProperty/MapServer/0) | APN, jurisdiction, tax rate area, situs address, Web-Mercator-corrected lot sq ft | Owner names strictly omitted (`is_owner_pii` minimization per `realestate-dd` ADR-0018/0019). County GIS omits assessed value & year built. |
| **2. FEMA Flood** | [San José `OPN_OpenDataService/MapServer/439`](https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService/MapServer/439) | FEMA flood zone, subtype, Special Flood Hazard Area flag | San José city coverage; confirm county/FEMA NFHL outside city limits. |
| **3. Multi-Hazard & Env** | San José `PLN_Geocortex_Public_PRD/81` (CGS Seismic), `FIR_AllReferenceLayers/4` (CAL FIRE 2025 FHSZ), `OEM_WaterHazards/9` (Dam failure inundation), `HSG_HousingMapLayers/17` (OEHHA CalEnviroScreen 5.0), `PLN_LandDesignations/31` (Cortese List 400 m) | Liquefaction/seismic zones, wildfire severity zone, Anderson/all-dam inundation flag, CalEnviroScreen / pollution / groundwater percentiles, nearby Cortese sites | Keyless point & buffer screening; does not replace Phase I ESA or NHD disclosure. |
| **4. Zoning & Development** | San José `OPN_OpenDataService/401` (Zoning), `OPN_OpenDataService/404` (General Plan 2040), `PLN_Geocortex_Public_PRD/84` (Height limits), `OPN_OpenDataService/455` (Major Private Developments 400 m) | Zoning code, General Plan designation, height/FAA limit & code section, active nearby major development pipeline | Preliminary screening only; confirm setbacks/FAR/ADU eligibility with Planning. |
| **5. Permits, Code & Historic** | San José `PLN_PermitsAndComplaints/{8,9,1}` (Active permits, Expired permits, Open code complaints 120 m), `OPN_OpenDataService/406` (Historic Resources 35 m) | Active & expired building permits (queried by resolved APN or 35 m buffer), nearby open code violations, historic landmarks & Mills Act status | Expired permits flag unfinaled work to verify during inspection. |
| **6. Safety & Crime (Context Only)** | [SJPD Quarterly Police Calls CKAN](https://data.sanjoseca.gov/dataset/police-calls-for-service-quarterly) (dynamic `package_show` resource discovery + SQL on resolved street corridor), `PLN_PermitsAndComplaints/13` (Police Beat), `OPN_OpenDataService/553` (5-yr crashes 250 m), plus verified **[SpotCrime](https://spotcrime.com) map deep-link** | Daily-updated anonymized SJPD corridor calls, police beat baseline tier, 5-yr nearby traffic crashes (total & KSI), direct SpotCrime coordinate link | **SpotCrime API caveat:** SpotCrime’s JSON API (`api.spotcrime.com/crimes.json`) requires a paid key (~$199+/mo) bound to a static egress IP (incompatible with keyless Workers). **Fair-housing firewall:** safety & neighborhood data are strictly context-only and never drive a pass/fail score. |
| **7. Neighborhood, Schools, Transit & Noise** | San José `OPN/{549,343,188,367,545}`, `SCCGISHUB/19`, `PLN_LandDesignations/{30,32}`, `PLN_Geocortex_Public_PRD/1` | Neighborhood, school district, active public schools (1.2 km), High-Quality Transit ½-mi (AB 2097), parks (600 m), road noise dBA, SJC airport CNEL, 500-ft freeway buffer, ACS tract median home value & income | Context only; verify school assignment directly with district. |

### Deterministic Underwriting & Target-Offer Calculator

Inside the **Underwrite** sub-tab, buyers and investors can model monthly PITI + HOA, CA Prop 13 base tax estimates (default 1.18%), annual NOI, Cap Rate, DSCR, Cash-on-Cash return, a **reverse target-offer price** for any target return (inspired by Reel #2 below), and export the full model as a CSV spreadsheet. All math is pure deterministic TypeScript (`src/lib/site-study-underwriting.ts`)—never LLM-estimated—mirroring `realestate-dd`’s **"THE LINE"** principle (ADR-0014).

**Save report for 24 hours** retains up to eight point-in-time snapshots in `localStorage` so reopening skips public-record lookups and expires automatically after 24 hours.

---

## Research Synthesis: Five `@noi.cre` Reels + `realestate-dd` Cloudflare Architecture

### Workflows & Linked Sources Extracted from the Five Reels

| Reel | Theme | Concrete Public/Open Sources Identified | How It Feeds This Lab |
| --- | --- | --- | --- |
| [`DgJfDNexmHd`](https://www.instagram.com/reel/DgJfDNexmHd/) | **Off-Market Deal Finder** | County deed/recorder history, low-rate acquisition windows (2020–2022), state LLC filings | Adds off-market selling-signal radar (long-hold / low-rate origination + entity ownership research, keeping durable owner PII segregated per CA Delete Act / ADR-0018). |
| [`DgK2sxwsQwM`](https://www.instagram.com/reel/DgK2sxwsQwM/) | **Automated Underwriter** | Listing facts, rent & sales comps, operating expenses, financing, downloadable spreadsheet | **Shipped now** in the **Underwrite** sub-tab (PITI, NOI, Cap Rate, DSCR, Cash-on-Cash, reverse target-offer solver, CSV export). Next: wire closed comps + 3-AVM spread. |
| [`DgLeLlMytdk`](https://www.instagram.com/reel/DgLeLlMytdk/) | **AI Value-Add / Renovation Screener** | Listing photos, vision condition flags (roof/kitchen/facade/parking), renovated comps ARV lift | Planned Cloudflare Workflow vision miner (`listing_forensics` / `value_add`) scoring photo condition and linking to renovated comp spread with explicit illustrative disclaimers. |
| [`DgMTVRts_5-`](https://www.instagram.com/reel/DgMTVRts_5-/) | **Underutilized Land & Development Scout** | [**`Center-for-Land-Economics/civicmapper`**](https://github.com/Center-for-Land-Economics/civicmapper) (MIT, GeoParquet/PMTiles parcel land vs. improvement value ratios & surface parking) + municipal zoning/height codes | **Zoning, General Plan 2040, Height Limits & Major Projects shipped now**; next: ingest CivicMapper/assessor Improvement-to-Land (I/L) ratio tiles to highlight underbuilt parcels on the map. |
| [`DgOxDgIMPig`](https://www.instagram.com/reel/DgOxDgIMPig/) | **Commercial Debt Maturity Radar** | [**`cmbs.news`**](https://cmbs.news) (public SEC-derived CMBS loan JSON API & hosted MCP server at `https://cmbs.news/mcp`, free tier 100 req/day) | Planned CRE debt-maturity overlay querying loan balance, coupon, maturity date, and DSCR to compute refinancing funding gaps at current rates. |

### Target Cloudflare Workers + Workflows Blueprint (from `baladithyab/realestate-dd` `archive/cloudflare-architecture-2026-07-04`)

To graduate this lab from synchronous single-Worker public-record lookups into full nationwide agentic due diligence without losing determinism, cost control, or compliance, adopt the archived `realestate-dd` Cloudflare architecture:

1. **Flat Sibling `WorkflowEntrypoint` Fan-Out (ADR-0017):**
   - Run a durable `DueDiligenceWorkflow` (`normalizeAddress → gatherData → Promise.allSettled(step.do("enrich.<family>")) → enrichmentMerge → extractFields → verify → computeVerdict → assembleReport → terminalProjection`).
   - Keep parallel facet miners as **top-level sibling `step.do()` calls** with tight retries (`limit: 2, exponential backoff`)—never nested inside `gatherData`. Convert terminal `4xx`/schema/APN-mismatch errors to `NonRetryableError`; let transient `429`/`5xx` throw so Workflows retries them; collapse exhausted rejections to explicit `gapFacet`s at fan-in.
2. **Family-Level `cf-miner` Plane (ADR-0025 & ADR-0029):**
   - Organize the 24 due-diligence facets into **10 isolated families** (`identity_assessor`, `hazard_environment`, `zoning_permits`, `title_liens`, `valuation_market`, `tax_regulatory`, `neighborhood_context`, `utilities_infrastructure`, `economic_trajectory`, `buy_box`) plus new scouting families (`land_upside` via CivicMapper, `debt_maturity` via `cmbs.news`, `value_add_vision`).
   - Low-latency API families run in-process or over private **Service Bindings** (`WorkerEntrypoint.dispatch(CfMinerTask)`); browser-heavy portal miners (Accela/eTRAKiT/county recorders via Cloudflare Browser Rendering) graduate to **Cloudflare Queues** with explicit DLQ and per-message `ack()`/`retry()`.
3. **Durable Budget, Cache & Provenance Storage (D1 + R2 + Coordinator DO + AI Gateway):**
   - **Coordinator Durable Object (SQLite):** Single-writer per-`report_id` budget reserve/reconcile ledger so Workflow replays never reset spend caps (ADR-0017 BF2 / ADR-0026).
   - **D1:** Tenant-scoped report fingerprints, `reuse_until` retention windows, `evidence_ledger`, and `VerdictView` JSON snapshots.
   - **R2 (`GuardedEvidenceStore`):** Content-addressed raw evidence (`sha256`) gated by a 4-class persistence policy (`no-persist-24h`, `persist-licensed`, `persist-free-official`, `persist-owned`) with R2 lifecycle expiration.
   - **AI Gateway (`collect_logs=false`):** Unified model routing, retries, and spend metering for extraction/vision/narration while enforcing **THE LINE** (ADR-0014): models gather and narrate, while a pure deterministic reducer authors every number, `risk_flag`, confidence band, and `Buy / Pass / Investigate` (or renter `Proceed / Caution / Investigate`) decision.
4. **Structural Compliance Guardrails (ADR-0018 & ADR-0021):**
   - Asset-scoped queries only (APN/address, never person-keyed consumer screening; FCRA Firewall A), CA Delete Act owner-PII minimization, fair-housing quarantine on crime/school/demographic context, and explicit gap transparency (`checked` vs. `open / paid-gated`) in the UI.

## Refresh the bundled road & Census sources

- Roads come from [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) under [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) (`roads.data`, OSM base date 2026-05-31).
- Census sources are the [2024 California cartographic tract boundaries](https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_06_tract_500k.zip) and the [2026 Planning Database tract CSV](https://www2.census.gov/adrm/PDB/2026/pdb2026tr.csv) (`census.data`).
- Regenerate via `uv run --no-project scripts/import-site-study.py roads.json cb_2024_06_tract_500k.zip pdb2026tr.csv`.
