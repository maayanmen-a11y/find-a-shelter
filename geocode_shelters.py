import openpyxl, json, time, urllib.request, urllib.parse, sys, ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

sys.stdout.reconfigure(encoding='utf-8')

EXCEL = "C:/Users/User/Downloads/114348849-\u05de\u05e7\u05dc\u05d8\u05d9\u05dd-\u05e6\u05d9\u05d1\u05d5\u05e8\u05d9\u05d9\u05dd-\u05ea\u05dc-\u05d0\u05d1\u05d9\u05d1-\u05d9\u05e4\u05d5.xlsx"
OUT  = "C:/Users/User/Downloads/Claude projects/Find a Shelter/shelters.json"

def geocode(address):
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({
        "q": address, "format": "json", "limit": 1, "countrycodes": "il"
    })
    req = urllib.request.Request(url, headers={"User-Agent": "ShelterFinder/1.0"})
    with urllib.request.urlopen(req, timeout=10, context=ctx) as r:
        data = json.loads(r.read())
    if data:
        return float(data[0]["lat"]), float(data[0]["lon"])
    return None, None

wb = openpyxl.load_workbook(EXCEL)
ws = wb.active
rows = list(ws.iter_rows(min_row=2, values_only=True))
total = len(rows)
print(f"Found {total} shelters. Geocoding... (~{total} seconds)")

shelters = []
failed  = 0

for i, row in enumerate(rows):
    num, kind, street, house, entrance, area, notes = row
    if not street or not house:
        continue
    address = f"{street} {house} \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1"
    try:
        lat, lon = geocode(address)
    except Exception as e:
        lat, lon = None, None
        print(f"[{i+1}/{total}] ERROR: {e}")
    if lat:
        shelters.append({
            "lat": lat, "lon": lon,
            "name": str(kind) if kind else "\u05de\u05d9\u05e7\u05dc\u05d8 \u05e6\u05d9\u05d1\u05d5\u05e8\u05d9",
            "address": f"{street} {house}",
            "source": "excel"
        })
        print(f"[{i+1}/{total}] OK: {street} {house}")
    else:
        failed += 1
        print(f"[{i+1}/{total}] FAILED: {street} {house}")
    time.sleep(1)

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(shelters, f, ensure_ascii=False, indent=2)

print(f"\nDone! {len(shelters)} shelters saved, {failed} failed.")
