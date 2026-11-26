# Site Study

`/lab/site-study` is an unlisted San José lab inspired by [Yehya’s Pillar reel](https://www.instagram.com/yehya_cre/reel/DgNtEF-pEcp/). Select a preset, click the map, or enter coordinates. The browser computes cumulative 5-, 10-, and 15-minute drive areas and shows estimated residents, households, and renter share. The dashed rectangle shows where a site can be placed. The road snapshot extends beyond it.

The model starts along the closest local road segment within 400 m and follows directed OpenStreetMap road edges using conservative road-class speeds capped by posted limits where available. It samples reachable non-freeway roads onto a 250 m grid and adds a short local-access allowance based on the distance to each cell center. Freeways can carry trips through the network. Turn restrictions, live traffic, conditional access, and routing outside the snapshot are outside the model. A reachable snapshot edge is flagged. The map and estimates describe outbound drive times and should be treated as approximate.

The 2026 Census Planning Database supplies 2020–2024 American Community Survey estimates of population and owner- and renter-occupied units. Counts are distributed across grid cells by overlap with each tract’s land-clipped geometry, assuming uniform density within the tract. Households are the sum of owner- and renter-occupied units. Renter share divides the estimated renter count by the household count for a window. The area and Census estimates both carry uncertainty.

## Property data

Import a CSV with `latitude` and `longitude` (or `lat` and `lon`/`lng`). Optional HomeHarvest field names include `formatted_address`, `sold_price`, `list_price`, and `status`. Generic `address` and `price` also work. The file stays in the tab and matches use the same grid cells as the map. Use data you have permission to use.

[HomeHarvest](https://github.com/ZacharyHampton/HomeHarvest) is a Python scraper of residential listings from Realtor.com. The package license covers its code. [Realtor.com’s terms](https://www.realtor.com/terms-of-use/) restrict automated access and reuse of its data. The lab accepts compatible CSVs and makes no request to Realtor.com. For a public residential feed, [RentCast](https://developers.rentcast.io/reference/property-listings) provides a keyed sale and rental listings API under [separate data terms](https://www.rentcast.io/terms-api). For commercial retail or land inventory, use a commercial feed licensed for the intended display. [Santa Clara County’s parcel service](https://maps.santaclaracounty.gov/server/rest/services/property/SCCProperty/MapServer) is a separate source for parcel boundaries and attributes.

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

From the repository root, run `uv run --no-project scripts/import-site-study.py roads.json cb_2024_06_tract_500k.zip pdb2026tr.csv`. It writes `public/lab/site-study/{roads,census}.data`. A missing or suppressed estimate causes regeneration to fail so the resulting totals do not silently omit it.
