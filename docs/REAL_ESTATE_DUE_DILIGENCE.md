# Real Estate Due Diligence

`/lab/real-estate-due-diligence` is an unlisted San José lab inspired by [Yehya’s Pillar reel](https://www.instagram.com/yehya_cre/reel/DgNtEF-pEcp/). Add up to five destinations with a map click, preset, address search, or coordinates. Right-click a pin or use its Remove button. Use **All points** to intersect drive areas and **Any point** to unite them. The browser shows estimated residents, households, and renter share for cumulative 5-, 10-, and 15-minute drive areas. Points must be inside the dashed rectangle. Address search sends the query and study bounds to [Photon](https://github.com/komoot/photon).

The model snaps destinations to the closest local road within 400 m and follows the directed OpenStreetMap graph in reverse to estimate drives **to** each destination. It uses road-class speeds capped by posted limits where available. It samples reachable non-freeway roads onto a 250 m grid and adds a short local-access allowance based on the distance to each cell center. Freeways can carry trips through the network. Turn restrictions, live traffic, conditional access, and routing outside the snapshot are outside the model. A reachable snapshot edge is flagged.

The 2026 Census Planning Database supplies 2020–2024 American Community Survey estimates of population and owner- and renter-occupied units. Counts are distributed across grid cells by overlap with each tract’s land-clipped geometry, assuming uniform density within the tract. Households are the sum of owner- and renter-occupied units. Renter share divides the estimated renter count by the household count for a window. The area and Census estimates both carry uncertainty.

## Property data

Choose **Load live listings** to pull a sample of up to 40 sale and 40 rental listings for San José. The site requests both types through a same-account service binding to a private Python Worker. The site caches successful samples per type for 15 minutes at each Cloudflare location and rate-limits provider refreshes. If one type fails, the other remains available and the lab shows the affected type. The map intersects the sample with the selected drive area. The sample does not represent all available inventory.

Import a CSV with `latitude` and `longitude` (or `lat` and `lon`/`lng`). Optional HomeHarvest field names include `formatted_address`, `sold_price`, `list_price`, `status`, `beds`, and `sqft`. Generic `address` and `price` also work. The file is parsed in the tab. Filter matches by listing type, price, beds, or floor area, and select a listing to see its estimated drive to each point.

[HomeHarvest](https://github.com/ZacharyHampton/HomeHarvest) is a Python scraper of residential listings from Realtor.com. [Version 2.1.0](https://pypi.org/project/homeharvest/2.1.0/) documents a Cloudflare Python Worker mode that uses Workers `fetch` and returns raw or Pydantic results. The lab processes compatible CSVs locally. [Realtor.com’s terms](https://www.realtor.com/terms-of-use/) restrict automated access and reuse of its data. For a public residential feed, [RentCast](https://developers.rentcast.io/reference/property-listings) provides a keyed sale and rental listings API under [separate data terms](https://www.rentcast.io/terms-api). For commercial retail or land inventory, use a commercial feed licensed for the intended display. [Santa Clara County’s parcel service](https://maps.santaclaracounty.gov/server/rest/services/property/SCCProperty/MapServer) is a separate source for parcel boundaries and attributes.

## Cloudflare HomeHarvest probe

The Python Worker in `workers/homeharvest` pins HomeHarvest 2.1.0. The website deployment workflow deploys `codeseys-homeharvest-preview` for PR versions and `codeseys-homeharvest` for production. Both run without public routes. The workflow adds `HOMEHARVEST` to the built site Worker after the Python service deploy. Local site builds can use CSV import with no Cloudflare credentials. The original `POST /probe` path requires a privately configured bearer token and limits requests to eight listings per type.

On 2026-11-26, a temporary Cloudflare deployment reported the `emscripten` runtime, rejected an unauthenticated listing request with HTTP 401, and returned eight geocoded sale listings and eight geocoded rental listings on two authenticated live requests. Those results are a point-in-time sample. The probe is separate from the site's deployment.

## Property reports

Select a matching property, open due diligence, and generate a report. The report includes the listing snapshot, modeled drives to the selected destinations, parcel candidates from Santa Clara County, and a screening from San José’s FEMA flood hazard layer. Each public lookup shows its source and check time. Multiple parcel matches and gaps in coverage remain visible. Confirm the property and unit against the county record before using a parcel candidate. The report leaves valuation, tax, title, and permit findings open.

The browser sends only the selected listing's coordinates to the report evidence endpoint. The Cloudflare Worker performs two fixed point-in-polygon queries, limits cache misses, and caches successful observations separately for up to 24 hours at each Cloudflare location. A failed source can be retried without repeating a cached successful source. **Save report for 24 hours** keeps a point-in-time snapshot in the same browser and site origin. Saved reports include the listing and selected destinations, reopen without repeating the public-record lookups, and expire after 24 hours. Up to eight snapshots are retained. [Santa Clara County parcel layer](https://maps.santaclaracounty.gov/server/rest/services/property/SCCProperty/MapServer/0) · [San José flood hazard layer](https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService/MapServer/439) · [Cloudflare Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)

## Proposed expanded coverage and agentic research

1. **Place search.** Load regional vector tiles as the map moves and use an address and place geocoder for autocomplete. Save each chosen point’s coordinates and travel-time limit. Keep map, routing, listing, and public-record coverage independent. The current lab uses a bundled San José road snapshot. [MapLibre vector sources](https://maplibre.org/maplibre-style-spec/sources/) · [Place search](https://docs.maptiler.com/guides/developer/location-services/geocoding-search/)
2. **Listing discovery.** Calculate reverse drive-time polygons to answer “can I get from this property to this place?” Combine the polygons by intersection for **all places** or union for **any place**. Query the listing provider over the combined extent, deduplicate listing IDs, then check coordinates against the actual polygons. Filter by sale or rent, asking price, property type, beds, and floor area when supplied. Keep each place’s travel time visible in the shortlist. [Valhalla isochrones](https://valhalla.github.io/valhalla/api/isochrone/)
3. **Agentic due diligence.** After the user confirms the parcel and assumptions, use a durable workflow to gather and validate evidence for closed comps, taxes, additional hazards, zoning, permits, and title where available. Follow the original realestate-dd project's source-by-source evidence and explicit gaps. Keep financial calculations deterministic, and show each source, its observation date, and any unresolved gaps. Use a typed report with purchase or rental sections appropriate to the deal. [Cloudflare Workflows](https://developers.cloudflare.com/workflows/)

### Shared report reuse and retention

Use a tenant-scoped fingerprint built from the resolved property or unit, deal type, normalized assumptions, report and rules versions, and selected places if the report uses them. Check D1 for a reusable result before starting a workflow. An atomic claim for the fingerprint and refresh generation lets concurrent callers share one in-flight report. Use the generation to derive a stable workflow ID so a retry after an interrupted start can recover the same job.

Keep report IDs, workflow status, and `reuse_until` in D1. Store report artifacts or evidence in private R2 where the source permits retention. Compute `reuse_until` from the shortest applicable evidence freshness window or provider term. Reuse fresh reports, display timestamps on saved reports, and start a new immutable version on explicit refresh. Enforce access and retention deadlines on each read. Use a scheduled cleanup for expired metadata and an R2 lifecycle policy as a backstop for deleting expired files. [D1 Worker API](https://developers.cloudflare.com/d1/worker-api/d1-database/) · [R2 lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)

## Refresh the bundled sources

- Roads come from [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) under [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). The bundled, publicly downloadable `roads.data` is a gzip-compressed JSON database. The source snapshot reports an OSM base date of 2026-05-31. The example below uses the [Private.coffee Overpass instance](https://overpass.private.coffee/) for a one-time download.
- The Census sources are the [2024 California cartographic tract boundaries](https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_06_tract_500k.zip) and the [2026 Planning Database tract CSV](https://www2.census.gov/adrm/PDB/2026/pdb2026tr.csv). The downloadable `census.data` is the gzip-compressed grid and land outline derived from those inputs.

For a snapshot refresh, download the [tract ZIP](https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_06_tract_500k.zip) and [Planning Database CSV](https://www2.census.gov/adrm/PDB/2026/pdb2026tr.csv). Run the road query below and save its response as `roads.json`.

```overpass
[out:json][timeout:90];
way[highway~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](37.08,-122.34,37.64,-121.53);
out body qt;
>;
out skel qt;
```

From the repository root, run `uv run --no-project scripts/import-site-study.py roads.json cb_2024_06_tract_500k.zip pdb2026tr.csv`. It writes `public/lab/real-estate-due-diligence/{roads,census}.data`. A missing or suppressed estimate causes regeneration to fail so the resulting totals do not silently omit it.
