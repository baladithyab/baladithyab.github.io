# Fixed meeting-point benchmark fixtures

`west-oakland.json` is a real **West Oakland, California** neighborhood graph,
kept outside production assets. It is small, not a citywide or medium-sized
benchmark. The bundled SF graph remains at `public/lab/meeting-point/sf.json`.

## Source and dates

The source is OSMnx's official `tests/input_data/West-Oakland.osm.bz2` fixture:

- [Pinned snapshot](https://raw.githubusercontent.com/gboeing/osmnx/5f3b46f048f9f0a693702cea5f29f2eaad840204/tests/input_data/West-Oakland.osm.bz2)
- Commit: `5f3b46f048f9f0a693702cea5f29f2eaad840204`
- Git blob: `8cf84a8abccdf84f110ecf315654c68c77f9b496` (11,717 compressed bytes)

The snapshot date is **unknown**; `fetched` and `provenance.snapshotDate` say so.
`provenance.importedAt` records this import separately, not the map's currency.
No public Overpass or geocoding query is needed to use this fixed asset.

## Normalization and scope

Bzip2-decoded OSM XML became Overpass-style elements with original IDs,
coordinates, way-node order and tags. The input contains 446 nodes and 31 highway
ways; 35 non-highway ways and 23 relations are outside the road input contract.
`src/lib/meeting-network.ts`'s unchanged `buildMeetingNetwork` (schema 2) applied
walkability filtering, geometry simplification, rounded metre weights, largest
connected component selection and named street-intersection candidates. Output
was constructed through `parseNetwork` in `src/lib/meeting-point.ts`.
Generation produced **100 nodes, 114 edges and 15 meeting places**.
Bounds are the full source-node extent, since complete ways extend beyond the
XML's declared bounds; both are recorded in the JSON. No coordinates, weights or
intersections were fabricated. This is not current coverage or an accessibility
guarantee. These counts are not performance or parity measurements.

## Local benchmark

```sh
node scripts/meeting-bench.mjs --fixture scripts/meeting-bench/fixtures/west-oakland.json --out west-oakland-benchmark.json
```

## Data license

© OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
Retain attribution, provenance and the [OSM copyright notice](https://www.openstreetmap.org/copyright).
Redistribution/public use must meet ODbL attribution, share-alike and database-access
obligations where applicable. OSMnx's MIT software license does not relicense OSM data.
