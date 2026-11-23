# Családfa – Használati és telepítési útmutató (Windows és Linux)

Ez az útmutató kifejezetten **kevésbé technikai felhasználóknak** készült: lépésről lépésre bemutatja, hogyan tudod elindítani a letöltött **Családfa** programot Windows vagy Linux számítógépen, külön Python vagy Node.js telepítése nélkül.

---

## 1. Melyik fájlt töltsd le?

A GitHub **Releases** oldalán (vagy a GitHub Actions **Artifacts** szakaszában) kétféle csomagot találsz:

- **Windows számítógéphez:** `csaladfa-...-windows-x64.zip`
- **Linux számítógéphez:** `csaladfa-...-linux-x64.tar.gz`

> **Tipp:** Az elkészült csomag már tartalmazza a teljes grafikus felületet, a Python + SQLite adatbázismotort és a képoptimalizálót is, így **internetkapcsolat nélkül, teljesen helyben fut**.

---

## 2. Indítás Windowson (`Csaladfa.exe`)

1. **Csomagold ki a ZIP fájlt:**
   - Kattints jobb gombbal a letöltött `csaladfa-...-windows-x64.zip` fájlra.
   - Válaszd az **Összes kibontása…** (*Extract All…*) menüpontot, és bontsd ki például az **Asztal** vagy a **Dokumentumok** mappába.
   - **Fontos:** Ne indítsd el a programot közvetlenül a ZIP fájl belsejéből kibontás nélkül!
2. **Indítsd el a programot:**
   - Nyisd meg a kibontott `Csaladfa` mappát.
   - Kattints duplán a **`Csaladfa.exe`** fájlra. (A mellette lévő `_internal` mappát hagyd mellette érintetlenül, erre szüksége van a programnak.)
3. **Ha megjelenik a Windows biztonsági figyelmeztetése (SmartScreen):**
   - Mivel a közösségi/egyéni kiadásokhoz nem mindig tartozik fizetős digitális aláírás, a Windows kiírhatja: *„A Windows megvédte a számítógépet”*.
   - Kattints a **További információ** (*More info*) szövegre, majd a **Futtatás mindenképp** (*Run anyway*) gombra.
   - Ha tűzfal-engedélyt kérne, elég csak a helyi/otthoni hálózatot engedélyezni (a program egyébként csak a saját gépeden, a `127.0.0.1` címen fut).
4. **Használat és bezárás:**
   - Néhány másodperc múlva automatikusan megnyílik az alapértelmezett böngésződ a Családfa felülettel.
   - Ha mégsem nyílna meg automatikusan, nézd meg a megnyílt fekete ablakban látható `http://127.0.0.1:...` címet, és írd be a böngésző címsorába.
   - **Munka befejezésekor** egyszerűen zárd be a fekete indítóablakot (vagy nyomd meg benne a `Ctrl+C` billentyűt).

---

## 3. Indítás Linuxon (`./csaladfa`)

1. **Csomagold ki a `.tar.gz` fájlt:**
   - Fájlkezelőből jobb klikk → **Kibontás ide** (*Extract Here*), vagy terminálban:
     ```bash
     tar -xzf csaladfa-*-linux-x64.tar.gz
     ```
2. **Indítsd el a programot:**
   - Lépj be a kibontott `csaladfa` mappába:
     ```bash
     cd csaladfa
     chmod +x csaladfa   # csak akkor szükséges, ha nem futtathatóként bontódott ki
     ./csaladfa
     ```
3. **Használat és bezárás:**
   - A program automatikusan megnyitja a böngészőt a helyi címen (`http://127.0.0.1:8001/`).
   - Leállításhoz zárd be a terminálablakot, vagy nyomj `Ctrl+C`-t.

---

## 4. Hol tárolódnak az adataid és hogyan ments biztonsági másolatot?

A program az adataidat **nem küldi fel sehova**, minden kizárólag a saját gépeden marad:

- **Windows:** `%LOCALAPPDATA%\Csaladfa\workspace` (általában `C:\Users\<Felhasználónév>\AppData\Local\Csaladfa\workspace`)
- **Linux:** `~/.local/share/csaladfa/workspace`

### Biztonsági mentés és költöztetés (`.ftree` fájl)
- A felületen válaszd a **Mentés és megnyitás** fület, majd kattints a **Családfa mentése (.ftree)** gombra.
- Így az egész családfa minden fényképpel együtt egyetlen, **SHA-256 ellenőrzőösszeggel védett** `.ftree` fájlba kerül, amit pendrive-on vagy e-mailben is könnyedén átadhatsz a családtagoknak.

---

## 5. Fejlesztőknek: GitHub Actions automatizmusok és kézi csomagolás

- **Folyamatos ellenőrzés (`.github/workflows/ci.yml`):**
  Minden `push` és `pull_request` (merge) esetén automatikusan lefutnak a Python backend tesztek (Linuxon és Windowson is), valamint a React + TypeScript típusellenőrzés (`npx tsc --noEmit`) és a production build (`npm run build`).
- **Linux és Windows csomagok készítése (`.github/workflows/build-targets.yml`):**
  - **Kézi indítás:** a GitHub → *Actions* → *Linux és Windows csomagolás* → *Run workflow* gombbal bármikor legyárthatók az artifactként letölthető csomagok.
  - **Kiadás (`v*` tag):** például egy `v1.0.0` tag feltöltésekor (`git tag v1.0.0 && git push origin v1.0.0`) a workflow automatikusan elkészíti és füstteszteli a Linux `.tar.gz` és Windows `.zip` csomagokat, majd `SHA256SUMS.txt` ellenőrzőfájllal együtt közzéteszi őket egy **GitHub Release**-ben.
- **Helyi tesztelés fejlesztői gépen:**
  ```bash
  npm run build
  python packaging/build_bundle.py --version helyi
  ```
