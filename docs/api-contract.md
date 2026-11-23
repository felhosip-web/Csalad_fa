# REST API Szerződés

Alapértelmezett helyi cím: `http://127.0.0.1:8001` (vagy a Vite/Express proxy-n keresztül `/api/*`).

## Rendszer és Csomagkezelés

- `GET /api/health` — Szerver állapot, SQLite motor és `pillow_available` jelző.
- `GET /api/tree?search=...` — Teljes családfa pillanatkép (`meta`, `persons`, `unions`, `parent_child`).
- `PATCH /api/tree/meta` — `{ "tree_name": "..." }` — Családfa nevének módosítása.
- `GET /api/package/export` — Aktív munkakönyvtár letöltése egyetlen `.ftree` ZIP fájlként.
- `POST /api/package/import` — `.ftree` fájl feltöltése (`multipart/form-data` vagy bináris törzs), validálása és betöltése.
- `POST /api/package/new` — `{ "tree_name": "..." }` — Üres családfa létrehozása.
- `POST /api/package/seed-sample` — Több házasságot és féltestvért bemutató minta családfa betöltése.

## Személyek (`persons`)

- `GET /api/persons?search=...` — Személyek listázása / keresése névre és születési névre.
- `POST /api/persons` — Új személy létrehozása (`full_name` kötelező; részleges dátumok pl. `"1954"`, `"1954-06"`, `"kb. 1920"` elfogadottak).
- `GET /api/persons/{id}` — Személy részletes csomagja: `person`, `parents`, `unions` (partnerrel és közös gyerekekkel), `children`, `siblings` (`full` / `half`).
- `PATCH /api/persons/{id}` — Részleges adatmódosítás.
- `DELETE /api/persons/{id}` — Személy és kapcsolódó relációk törlése.
- `POST /api/persons/{id}/avatar` — Portrékép feltöltése és optimalizálása.
- `DELETE /api/persons/{id}/avatar` — Portrékép eltávolítása.

## Gyors kapcsolathozzáadás (kevésbé technikai felhasználóknak)

- `POST /api/persons/{id}/quick-parent` — Új szülő létrehozása és összekapcsolása (`relation_type`, opcionális `union_id`).
- `POST /api/persons/{id}/quick-child` — Új gyermek létrehozása és összekapcsolása (`union_id`, `link_both_partners: true`).
- `POST /api/persons/{id}/quick-partner` — Új partner létrehozása és `union` rekord felvétele (`status`, `start_date`, `end_date`).

## Párkapcsolatok (`unions`) és Szülő-gyermek linkek (`parent_child`)

- `POST /api/unions` — Kapcsolat létrehozása két meglévő személy között (vagy egy ismert partnerrel).
- `PATCH /api/unions/{id}` — Állapot (`married`, `divorced`, `partner`, `widowed`, `separated`, `unknown`) és dátumok frissítése.
- `DELETE /api/unions/{id}` — Kapcsolat törlése (a gyerekek `union_id`-ja biztonságosan `NULL`-ra áll).
- `POST /api/relations` — `{ "child_id", "parent_id", "union_id", "relation_type" }` — Meglévő személyek összekötése ciklusellenőrzéssel.
- `DELETE /api/relations/{child_id}/{parent_id}` — Szülő-gyermek kapcsolat bontása.
