# Családfa — Hordozható Családfakészítő és -szerkesztő

Linuxon és Windowson egyaránt futó, számítógéphez kevésbé értő felhasználók számára tervezett családfa-alkalmazás **Python backenddel** (SQLite + `.ftree` ZIP csomagformátum + Pillow képoptimalizálás) és **React frontenddel**.

## Fő jellemzők (1. fázis: Architektúra, adatszint és API-szerződés)

- **Egyetlen hordozható `.ftree` fájl**: szabványos ZIP archívum (`family.db` + `media/` + `meta.json`), így a teljes családfa képekkel együtt egyetlen fájlként menthető, másolható és megosztható.
- **SQLite idegen kulcsokkal és séma-verziózással**: `PRAGMA foreign_keys = ON`, `schema_migrations` tábla, biztonságos előre irányú migrációs keretrendszer.
- **Több házasság, válás és féltestvérek**: a `unions` és `parent_child.union_id` modell pontosan megkülönbözteti a különböző házasságokból származó gyermekeket és féltestvéreket.
- **Részleges dátumok elfogadása**: elfogadja a csak évszámot (`1954`), év-hónapot (`1954-06`), teljes dátumot (`1954-06-15`), a magyar pontos formátumot (`1954.06.15.`), valamint a közelítő jelölést (`~1920`, `kb. 1920`).
- **Biztonságos kép- és csomagkezelés**: Pillow-alapú portré átméretezés (`max 512×512`, EXIF forgatás korrekció, WebP/JPEG tömörítés), valamint Zip Slip és path traversal elleni védelem.

## Mappastruktúra

```text
.
├── backend/
│   ├── __init__.py
│   ├── schema.sql          # SQLite táblák, megszorítások és indexek
│   ├── models.py           # Domain adatmodellek és strukturált hibák
│   ├── validators.py       # Részleges dátum- és bemenet-validátorok
│   ├── db.py               # SQLite kapcsolatkezelő és migrációs motor
│   ├── media.py            # Pillow portréoptimalizáló és médiaútvonal-védelem
│   ├── package.py          # .ftree (ZIP) csomagoló és biztonságos kicsomagoló
│   ├── repository.py       # Paraméterezett SQLite CRUD réteg
│   ├── service.py          # Üzleti logika (ciklusvédelem, gyors hozzáadás, testvérszámítás)
│   ├── version.py          # Backend verziószám egyetlen forrása
│   ├── server.py           # Nulla külső függőséges Python HTTP API szerver
│   ├── fastapi_app.py      # Opcionális FastAPI + Uvicorn belépési pont
│   ├── requirements.txt    # Python függőségek (Pillow, FastAPI, Uvicorn, pytest)
│   └── tests/
│       └── test_backend.py # Adatszint-, csomag- és HTTP API tesztek
├── src/                    # React + TypeScript frontend (Vite)
│   ├── api/client.ts       # Típusos API kliens
│   ├── types/family.ts     # TypeScript domain típusok
│   ├── components/         # Moduláris UI komponensek (köztük a Footer.tsx)
│   ├── App.tsx             # Fő családfa felület
│   └── index.css           # Tailwind CSS v4 stílusok
├── docs/
│   ├── architecture.md               # Részletes architektúra és csomagformátum leírás
│   ├── api-contract.md               # REST API végpontok és JSON szerződés
│   └── terjesztes-linux-windows.md   # Végfelhasználói útmutató Linux és Windows csomagokhoz
├── packaging/
│   ├── run_desktop.py                # Önálló asztali indító (beépített React + Python API)
│   └── build_bundle.py               # PyInstaller csomagoló (Windows .zip / Linux .tar.gz)
├── scripts/
│   └── bump_version.py               # Backend és frontend verzióléptető szkript
├── .github/workflows/
│   ├── ci.yml                        # Folyamatos ellenőrzés (tesztek, tsc, build)
│   ├── build-targets.yml             # Windows és Linux kiadási csomagok készítése
│   └── version-bump.yml              # Automatikus / kézi verzióléptető workflow
├── server.ts                         # Helyi fejlesztői Express híd (Python API proxy + Vite)
└── package.json
```

## Indítás Linuxon és Windowson

### 1. Python tesztek futtatása
```bash
python3 -m unittest discover -s backend/tests -v
```

### 2. Teljes alkalmazás indítása fejlesztői módban (Python backend + React frontend)
```bash
npm install
npm run dev
```
*(Opciónálisan a Python csomagok telepítése portré-átméretezéshez és FastAPI-hoz: `pip install -r backend/requirements.txt`, majd önállóan: `uvicorn backend.fastapi_app:app --host 127.0.0.1 --port 8001` vagy `python -m backend.server --port 8001`.)*

### 3. Önálló asztali csomag (végfelhasználóknak, Node.js nélkül)
A GitHub Releases oldaláról letölthető Linux és Windows csomagok indításához olvasd el a részletes magyar útmutatót:
[Linux és Windows használati és telepítési útmutató](docs/terjesztes-linux-windows.md).

