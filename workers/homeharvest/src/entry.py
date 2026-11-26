"""San José listing samples for the site Worker and the authenticated probe."""

import hmac
import math
import sys
from time import monotonic
from urllib.parse import parse_qs, urlsplit

from homeharvest import scrape_property
from workers import Response, WorkerEntrypoint


MARKET = "San Jose, CA"
PROBE_LIMIT = 8
LISTINGS_LIMIT = 40
KINDS = ("for_sale", "for_rent")


def reply(body, status=200):
    return Response.from_json(body, status=status, headers={"Cache-Control": "no-store"})


def normalize(row, kind):
    lat, lon = row.latitude, row.longitude
    if lat is None or lon is None or not (math.isfinite(lat) and math.isfinite(lon)):
        return None
    if abs(lat) > 90 or abs(lon) > 180:
        return None
    description = row.description
    return {
        "id": row.property_id,
        "address": row.address.formatted_address if row.address else None,
        "latitude": lat,
        "longitude": lon,
        "list_price": row.list_price,
        "status": kind,
        "beds": description.beds if description else None,
        "sqft": description.sqft if description else None,
        "url": str(row.property_url),
    }


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        url = urlsplit(request.url)
        if request.method == "GET" and url.path == "/health":
            return reply({"runtime": sys.platform, "adapter": "homeharvest-2.1.0"})
        if request.method == "POST" and url.path == "/probe":
            secret = getattr(self.env, "POC_TOKEN", None)
            bearer = request.headers.get("Authorization") or ""
            if not secret or not hmac.compare_digest(bearer.encode(), f"Bearer {secret}".encode()):
                return reply({"error": "unauthorized"}, 401)
            limit = PROBE_LIMIT
        elif request.method == "GET" and url.path == "/listings":
            # This Worker has no public route. The site reaches it by service binding.
            limit = LISTINGS_LIMIT
        else:
            return reply({"error": "not_found"}, 404)
        kinds = parse_qs(url.query).get("kind", [])
        if len(kinds) != 1 or kinds[0] not in KINDS:
            return reply({"error": "choose_for_sale_or_for_rent"}, 400)

        kind = kinds[0]
        start = monotonic()
        evidence = {"market": MARKET, "kind": kind, "runtime": sys.platform}
        try:
            rows = scrape_property(
                MARKET, listing_type=kind, return_type="pydantic", limit=limit, parallel=False
            )
            geocoded = [item for row in rows if (item := normalize(row, kind)) is not None]
        except Exception as error:
            return reply({**evidence, "elapsed_ms": round(1000 * (monotonic() - start)),
                          "error": type(error).__name__}, 502)
        return reply({**evidence, "elapsed_ms": round(1000 * (monotonic() - start)),
                      "count": len(rows), "geocoded_count": len(geocoded), "listings": geocoded})
