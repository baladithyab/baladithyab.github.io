# /// script
# requires-python = ">=3.11"
# dependencies = ["pyshp==3.1.9", "shapely==2.2.0"]
# ///
"""Build the versioned San José snapshots from downloaded public sources."""

import argparse
import csv
import gzip
import json
import math
import re
from pathlib import Path

import shapefile
from shapely import make_valid, transform
from shapely.geometry import LineString, box, shape
from shapely.ops import unary_union


BOUNDS = (-122.34, 37.08, -121.53, 37.64)
LON_METRES, LAT_METRES = 88_400, 111_195
CELL = 250
WIDTH = (BOUNDS[2] - BOUNDS[0]) * LON_METRES
HEIGHT = (BOUNDS[3] - BOUNDS[1]) * LAT_METRES
COLUMNS, ROWS = math.ceil(WIDTH / CELL), math.ceil(HEIGHT / CELL)
EXTENT = box(0, 0, WIDTH, HEIGHT)
SPEED = {
    "motorway": 100, "motorway_link": 50, "trunk": 75, "trunk_link": 46,
    "primary": 55, "primary_link": 37, "secondary": 47, "secondary_link": 33,
    "tertiary": 40, "tertiary_link": 32, "unclassified": 34,
    "residential": 32, "living_street": 16,
}


def project(lon, lat):
    return (lon - BOUNDS[0]) * LON_METRES, (lat - BOUNDS[1]) * LAT_METRES


def store(folder, name, payload):
    raw = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode()
    (folder / f"{name}.data").write_bytes(gzip.compress(raw, compresslevel=9, mtime=0))


def drive_network(path):
    data = json.loads(path.read_bytes())
    if data.get("remark"):
        raise ValueError(data["remark"])
    coordinates = {
        row["id"]: project(row["lon"], row["lat"])
        for row in data["elements"] if row["type"] == "node"
    }
    nodes, edges, ids = [], [], {}

    def node(key, point):
        if key not in ids:
            ids[key] = len(nodes)
            nodes.append([round(axis) for axis in point])
        return ids[key]

    for way in data["elements"]:
        if way["type"] != "way":
            continue
        tags = way["tags"]
        kind = tags.get("highway")
        access = next((tags[key] for key in ("motorcar", "motor_vehicle", "vehicle", "access") if key in tags), "yes")
        if kind not in SPEED or access not in {"yes", "permissive", "designated", "official"}:
            continue
        direction = tags.get("oneway:motor_vehicle", tags.get("oneway"))
        if direction in {"reversible", "alternating"}:
            continue
        if direction is None and (kind == "motorway" or tags.get("junction") in {"roundabout", "circular"}):
            direction = "yes"
        one_way = {"-1": -1, "yes": 1, "true": 1, "1": 1}.get(direction, 0)
        rank = 3 if kind.startswith("motorway") or tags.get("expressway") == "yes" else (
            2 if kind.startswith(("trunk", "primary")) else 1 if kind.startswith(("secondary", "tertiary")) else 0
        )
        for i, (a, b) in enumerate(zip(way["nodes"], way["nodes"][1:])):
            p, q = coordinates[a], coordinates[b]
            if not (0 <= p[0] <= WIDTH and 0 <= p[1] <= HEIGHT and 0 <= q[0] <= WIDTH and 0 <= q[1] <= HEIGHT):
                part = LineString([p, q]).intersection(EXTENT)
                if part.is_empty or part.geom_type != "LineString":
                    continue
                new_p, new_q = part.coords[0], part.coords[-1]
                if new_p != p:
                    a, p = (way["id"], i, 0), new_p
                if new_q != q:
                    b, q = (way["id"], i, 1), new_q
            distance = math.dist(p, q)
            if distance < 1:
                # Retain distinct OSM node IDs that connect through a very short segment.
                if a == b:
                    continue
                distance = 1
            speed = SPEED[kind]
            limit = re.fullmatch(r"(\d+)(?:\s*(mph|km/h))?", tags.get("maxspeed", ""))
            if limit and int(limit[1]) > 0:
                speed = min(speed, int(limit[1]) * (1.609344 if limit[2] == "mph" else 1))
            edges.append([node(a, p), node(b, q), round(distance * 3.6 / speed, 2), one_way, rank])
    if len(edges) < 1_000:
        raise ValueError("Road extract is missing or unexpectedly small.")
    date = data["osm3s"]["timestamp_osm_base"][:10]
    print(f"Roads {date}: {len(nodes):,} nodes, {len(edges):,} edges")
    return {"date": date, "nodes": nodes, "edges": edges}


def tract_grid(tract_file, pdb_file):
    fields = ["Tot_Population", "Owner_Occp_HU", "Renter_Occp_HU"]
    with pdb_file.open(encoding="utf-8-sig", errors="replace", newline="") as stream:
        data = {
            str(row["State"]).zfill(2) + str(row["County"]).zfill(3) + str(row["Tract"]).zfill(6):
            [int(row[f"{field}_ACS_20_24"] or -1) for field in fields]
            for row in csv.DictReader(stream) if row["State"].zfill(2) == "06"
        }
    cells, land = {}, []
    tracts = shapefile.Reader(tract_file)
    for entry in tracts.iterShapeRecords(bbox=BOUNDS):
        tract = transform(make_valid(shape(entry.shape.__geo_interface__)), project, interleaved=False)
        if tract.area <= 0 or not tract.intersects(EXTENT):
            continue
        within = tract.intersection(EXTENT)
        if within.area <= 0:
            continue
        land.append(within)
        geoid = entry.record["GEOID"]
        if geoid not in data:
            raise ValueError(f"Tract {geoid} is missing from the Planning Database.")
        population, owners, renters = data[geoid]
        if min(population, owners, renters) < 0:
            raise ValueError(f"Tract {geoid} has missing or suppressed estimates.")
        if population == owners == renters == 0:
            continue
        x1, y1, x2, y2 = within.bounds
        for y in range(max(0, int(y1 / CELL)), min(ROWS, math.ceil(y2 / CELL))):
            for x in range(max(0, int(x1 / CELL)), min(COLUMNS, math.ceil(x2 / CELL))):
                area = within.intersection(box(x * CELL, y * CELL, (x + 1) * CELL, (y + 1) * CELL)).area
                if area:
                    share = area / tract.area
                    totals = cells.setdefault(y * COLUMNS + x, [0, 0, 0])
                    totals[0] += population * share
                    totals[1] += (owners + renters) * share
                    totals[2] += renters * share
    geometry = unary_union(land).simplify(40)
    polygons = [geometry] if geometry.geom_type == "Polygon" else geometry.geoms
    outline = [[[round(x), round(y)] for x, y in ring.coords]
               for polygon in polygons if polygon.area > 10_000
               for ring in (polygon.exterior, *polygon.interiors)]
    if len(cells) < 1000:
        raise ValueError("Tract snapshot is unexpectedly small.")
    print(f"Census: {len(land):,} tracts, {len(cells):,} populated grid cells")
    return {"cellSize": CELL, "columns": COLUMNS, "rows": ROWS, "outline": outline,
            "cells": [[key, *[round(value, 4) for value in values]] for key, values in sorted(cells.items())]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("roads", "tracts", "pdb"):
        parser.add_argument(key, type=Path)
    args = parser.parse_args()
    out = Path("public/lab/site-study")
    out.mkdir(parents=True, exist_ok=True)
    roads = drive_network(args.roads)
    census = tract_grid(args.tracts, args.pdb)
    store(out, "roads", roads)
    store(out, "census", census)


if __name__ == "__main__":
    main()
