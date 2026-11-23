# Architektúra és Mappastruktúra

## 1. Rétegzett felépítés

1. **Adatszint (`backend/schema.sql`, `backend/db.py`, `backend/repository.py`)**
   - Minden SQLite kapcsolat bekapcsolja a `PRAGMA foreign_keys = ON;`, `PRAGMA busy_timeout = 5000;` és `PRAGMA journal_mode = WAL;` beállításokat.
   - A séma verziózását a `schema_migrations` tábla és a `PRAGMA user_version` végzi. Ha a jövőben új mező vagy tábla kerül a sémába, a `MIGRATIONS` lista tranzakcióban frissíti a régebbi `.ftree` fájlok adatbázisát.
   - Minden SQL művelet paraméterezett lekérdezéssel fut.

2. **Hordozható `.ftree` csomag (`backend/package.py`)**
   - A `.ftree` fájl szabványos ZIP archívum:
     ```text
     pelda.ftree
     ├── meta.json        # Formátumverzió, séma verzió, fa neve, darabszámok
     ├── family.db        # Konzisztens SQLite pillanatkép (sqlite3.Connection.backup)
     └── media/
         └── avatars/     # Optimalizált portréképek (WebP / JPEG)
     ```
   - Kicsomagoláskor az archívum minden tagja átesik Zip Slip útvonal-ellenőrzésen (`PurePosixPath` + `is_relative_to`), méretkorlát-ellenőrzésen és `PRAGMA integrity_check` vizsgálaton, mielőtt felülírná az aktív munkakönyvtárat.

3. **Médiaoptimalizálás (`backend/media.py`)**
   - `Pillow` jelenlétében automatikusan korrigálja az okostelefonos EXIF forgatást, RGB-re konvertál, maximum `512×512` px méretre skáláz, és WebP/JPEG formátumba tömörít.
   - Minimális környezetben (Pillow nélkül) magic-byte ellenőrzéssel biztosítja, hogy csak valódi PNG/JPEG/WEBP fájlok kerüljenek a `media/avatars/` mappába.

4. **Genealógiai szolgáltatásréteg (`backend/service.py`)**
   - **Ciklusvédelem**: új szülő-gyermek kapcsolat felvétele előtt szélességi kereséssel ellenőrzi, hogy a gyermek nem őse-e a szülőnek.
   - **Több házasság és féltestvérek**: a `parent_child.union_id` mező segítségével egy gyermek pontosan egy adott kapcsolathoz köthető. A `get_person_bundle()` ebből automatikusan számolja a `full` (mindkét szülő közös) és `half` (csak egy szülő közös) testvérviszonyokat.
   - **Gyors felvételi útvonalak**: `quick_add_parent`, `quick_add_child`, `quick_add_partner` egyetlen API-hívással hozza létre az új személyt és a hozzá tartozó kapcsolatot.
