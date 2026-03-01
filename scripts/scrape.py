#!/usr/bin/env python3
"""
Scraper for beach volleyball tournaments from bvs.ffvbbeach.org
Outputs data/tournaments.json with geocoded locations.
"""

import json
import re
import time
from datetime import datetime
from pathlib import Path

import requests
from bs4 import BeautifulSoup
from geopy.geocoders import Nominatim
from geopy.exc import GeocoderTimedOut, GeocoderServiceError

BASE_URL = "https://bvs.ffvbbeach.org/mixte"
DATA_DIR = Path(__file__).parent.parent / "data"
GEOCACHE_FILE = DATA_DIR / "geocache.json"
OUTPUT_FILE = DATA_DIR / "tournaments.json"

MONTH_FR = {
    "Janvier": 1, "Février": 2, "Mars": 3, "Avril": 4,
    "Mai": 5, "Juin": 6, "Juillet": 7, "Août": 8,
    "Septembre": 9, "Octobre": 10, "Novembre": 11, "Décembre": 12,
    # Variants with encoding issues
    "F\xe9vrier": 2, "Ao\xfbt": 8,
}

GENRE_MAP = {"M": "Masculin", "F": "Féminin", "X": "Mixte"}

# Current and next season IDs (season 20 = 2026, 19 = 2025)
SEASONS = [20]  # Only current season for now; add more if needed


def get_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (compatible; BeachVolleyMap/1.0)",
    })
    # Establish PHP session by visiting the listing page first
    session.get(f"{BASE_URL}/page.php?P=fo/public/menu/tournoi/index")
    return session


def parse_date_fr(date_str: str) -> str | None:
    """Parse French date like '15 Mars 2026' to ISO '2026-03-15'."""
    date_str = date_str.strip()
    parts = date_str.split()
    if len(parts) < 3:
        return None
    try:
        day = int(parts[0])
        month = MONTH_FR.get(parts[1])
        year = int(parts[2])
        if month:
            return f"{year:04d}-{month:02d}-{day:02d}"
    except (ValueError, IndexError):
        pass
    return None


def fetch_tournament_list(session: requests.Session, season_id: int) -> list[dict]:
    """Fetch all tournaments for a given season (all pages)."""
    tournaments = []
    page = 1

    while True:
        resp = session.post(
            f"{BASE_URL}/page.php?P=fo/public/menu/tournoi/index",
            data={
                "Action": "tournoi_filtrer",
                "affich_select_saison": season_id,
                "affich_text_nom": "",
                "affich_select_type": "",
                "affich_select_genre": "",
                "page_hidden_pageActuelle": page,
            },
        )
        resp.encoding = "latin-1"
        soup = BeautifulSoup(resp.text, "lxml")

        rows = soup.find_all("tr", onclick=re.compile(r"afficher_fiche"))
        if not rows:
            break

        for row in rows:
            onclick = row.get("onclick", "")
            m = re.search(r"afficher_fiche\((\d+),(\d+)\)", onclick)
            if not m:
                continue
            tid = m.group(1)

            tds = row.find_all("td")
            if len(tds) < 5:
                continue

            date_str = tds[1].get_text(strip=True)
            name = tds[2].get_text(strip=True)
            serie = tds[3].get_text(strip=True)
            genre_code = tds[4].get_text(strip=True)

            tournaments.append({
                "id": tid,
                "name": name,
                "date_str": date_str,
                "date": parse_date_fr(date_str),
                "serie": serie,
                "genre": GENRE_MAP.get(genre_code, genre_code),
                "genre_code": genre_code,
                "season": season_id,
            })

        # Check for next page
        has_next = bool(soup.find(string=re.compile(r"ixnet_paginer\(\s*" + str(page + 1))))
        if not has_next:
            # Also check via paginer calls in JS
            js_text = resp.text
            next_pages = re.findall(r"ixnet_paginer\((\d+)\)", js_text)
            next_pages = [int(p) for p in next_pages if int(p) > page]
            if not next_pages:
                break
        page += 1
        time.sleep(0.5)

    return tournaments


def fetch_tournament_detail(session: requests.Session, tid: str, season_id: int) -> dict:
    """Fetch city and address from the tournament presentation AJAX endpoint."""
    resp = session.post(
        f"{BASE_URL}/includer.php?inc=ajax/tournoi/fo_tournoi_fiche_presentation",
        data={
            "Action": "",
            "tournoiId": tid,
            "saisonId": season_id,
            "fo": 1,
            "isResp": "0",
        },
    )
    resp.encoding = "latin-1"
    soup = BeautifulSoup(resp.text, "lxml")

    detail: dict[str, str | None] = {"city": None, "address": None, "date_start": None, "date_qual": None}

    # Parse label→value pairs from <td class="tdLabel"> followed by <td>
    for label_td in soup.find_all("td", class_="tdLabel"):
        label = label_td.get_text(strip=True).rstrip(":").rstrip("\xa0").strip()
        value_td = label_td.find_next_sibling("td")
        if not value_td:
            continue
        # Replace <br> with space then extract text
        for br in value_td.find_all("br"):
            br.replace_with(" ")
        value = " ".join(value_td.get_text().split())

        if label == "Ville":
            detail["city"] = value or None
        elif "Site de comp" in label and "tableau principal" in label:
            detail["address"] = value or None
        elif label == "Dates tableau principal":
            # Value may be like "Dimanche 15 Mars 2026" — skip day name
            parts = value.split()
            if len(parts) >= 3:
                # Try parsing last 3 tokens as day month year
                detail["date_start"] = parse_date_fr(" ".join(parts[-3:]))
        elif label == "Dates qualification":
            parts = value.split()
            if len(parts) >= 3:
                detail["date_qual"] = parse_date_fr(" ".join(parts[-3:]))

    return detail


def load_geocache() -> dict:
    if GEOCACHE_FILE.exists():
        with open(GEOCACHE_FILE, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_geocache(cache: dict) -> None:
    DATA_DIR.mkdir(exist_ok=True)
    with open(GEOCACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)


def geocode_address(geolocator: Nominatim, address: str, cache: dict) -> tuple[float | None, float | None]:
    """Geocode an address, with caching."""
    if address in cache:
        cached = cache[address]
        if cached is None:
            return None, None
        return cached["lat"], cached["lon"]

    try:
        time.sleep(1.1)  # Nominatim rate limit: 1 req/sec
        location = geolocator.geocode(address + ", France", timeout=10)
        if location:
            cache[address] = {"lat": location.latitude, "lon": location.longitude}
            return location.latitude, location.longitude
        else:
            # Try just the city
            cache[address] = None
            return None, None
    except (GeocoderTimedOut, GeocoderServiceError) as e:
        print(f"  Geocoding error for '{address}': {e}")
        return None, None


def build_geocode_query(detail: dict, name: str) -> str:
    """Build the best geocoding query from available data."""
    if detail.get("address"):
        # Extract postcode + city if present
        m = re.search(r"(\d{5})\s*[-–]?\s*([A-Z][^F][^\n]+?)(?:\s+FRANCE)?$", detail["address"])
        if m:
            return f"{m.group(2).strip()}, {m.group(1)}"
        return detail["address"]
    if detail.get("city"):
        return detail["city"]
    return name  # fallback: try to geocode by tournament name


def main():
    DATA_DIR.mkdir(exist_ok=True)
    session = get_session()
    geocache = load_geocache()
    geolocator = Nominatim(user_agent="beach-volley-map/1.0")

    all_tournaments = []
    seen_ids = set()

    print("Fetching tournament lists...")
    for season_id in SEASONS:
        print(f"  Season {season_id}...")
        tournaments = fetch_tournament_list(session, season_id)
        print(f"  Found {len(tournaments)} entries")
        all_tournaments.extend(tournaments)
        time.sleep(0.5)

    print(f"\nFetching details for {len(all_tournaments)} entries...")
    results = []

    for i, t in enumerate(all_tournaments):
        tid = t["id"]
        season_id = t["season"]
        key = f"{tid}_{season_id}"

        if key in seen_ids:
            continue
        seen_ids.add(key)

        print(f"  [{i+1}/{len(all_tournaments)}] {t['name']} (ID={tid})")

        try:
            detail = fetch_tournament_detail(session, tid, season_id)
            time.sleep(0.3)
        except Exception as e:
            print(f"    Error fetching detail: {e}")
            detail = {}

        # Determine dates
        date_start = detail.get("date_qual") or detail.get("date_start") or t.get("date")
        date_end = detail.get("date_start") or t.get("date")

        # Geocode
        query = build_geocode_query(detail, t["name"])
        lat, lon = geocode_address(geolocator, query, geocache)
        if lat is None:
            # Fallback: try just the city name
            city = detail.get("city")
            if city and city != query:
                lat, lon = geocode_address(geolocator, city, geocache)

        if lat is None:
            print(f"    WARNING: could not geocode '{query}'")

        entry = {
            "id": tid,
            "name": t["name"],
            "date_start": date_start,
            "date_end": date_end,
            "genre": t["genre"],
            "genre_code": t["genre_code"],
            "serie": t["serie"],
            "city": detail.get("city") or "",
            "address": detail.get("address") or "",
            "lat": lat,
            "lon": lon,
        }
        results.append(entry)

    # Save geocache after each run to preserve progress
    save_geocache(geocache)

    # Filter out entries with no coordinates
    geocoded = [r for r in results if r["lat"] is not None]
    no_coords = [r for r in results if r["lat"] is None]

    print(f"\n✓ {len(geocoded)} tournaments geocoded, {len(no_coords)} without coordinates")
    if no_coords:
        print("  Without coordinates:")
        for r in no_coords:
            print(f"    - {r['name']} ({r['city']})")

    # Save all (including without coords, frontend can handle None)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(f"✓ Saved {len(results)} tournaments to {OUTPUT_FILE}")
    print(f"  Updated: {datetime.now().strftime('%Y-%m-%dT%H:%M:%SZ')}")


if __name__ == "__main__":
    main()
