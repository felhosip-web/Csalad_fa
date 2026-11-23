import type { Person } from '../types/family';

/**
 * Részleges vagy teljes dátumok egységes magyar megjelenítése.
 * Pl. "1945-04-12" -> "1945. 04. 12.", "2018-11" -> "2018. 11.", "~1920" -> "kb. 1920"
 */
export function formatHungarianDate(value: string): string {
  const raw = (value || '').trim();
  if (!raw) return '';

  const approx = raw.startsWith('~');
  const clean = approx ? raw.slice(1).trim() : raw;
  const parts = clean.split('-');

  let formatted = clean;
  if (parts.length === 1 && /^\d{4}$/.test(parts[0])) {
    formatted = parts[0];
  } else if (parts.length === 2) {
    formatted = `${parts[0]}. ${parts[1].padStart(2, '0')}.`;
  } else if (parts.length === 3) {
    formatted = `${parts[0]}. ${parts[1].padStart(2, '0')}. ${parts[2].padStart(2, '0')}.`;
  }

  return approx ? `kb. ${formatted}` : formatted;
}

/**
 * Évszám kinyerése kártyás megjelenítéshez (pl. "1942" vagy "kb. 1920").
 */
export function extractDisplayYear(value: string): string {
  const raw = (value || '').trim();
  if (!raw) return '';
  const approx = raw.startsWith('~');
  const match = raw.match(/\d{4}/);
  if (!match) return '';
  return approx ? `kb. ${match[0]}` : match[0];
}

/**
 * Személykártyán megjelenő évszámsor:
 * pl. "1942 – 2018", "1968 –", "1942 – †" vagy "Élő személy"
 */
export function formatCardYears(person: Pick<Person, 'birth_date' | 'death_date' | 'is_living'>): string {
  const bYear = extractDisplayYear(person.birth_date);
  const dYear = extractDisplayYear(person.death_date);

  if (bYear && dYear) {
    return `${bYear} – ${dYear}`;
  }
  if (bYear && !person.is_living) {
    return `${bYear} – †`;
  }
  if (bYear) {
    return `${bYear} –`;
  }
  if (dYear) {
    return `? – ${dYear}`;
  }
  return person.is_living ? 'Élő személy' : 'Elhunyt';
}

/**
 * Magyar monogram kép nélküli portrékártyához.
 */
export function getInitials(fullName: string): string {
  const parts = fullName
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

/**
 * Dátumbélyeg magyar formátumban (pl. csomag utolsó módosítása).
 */
export function formatTimestampHu(isoString: string): string {
  if (!isoString) return '—';
  const dt = new Date(isoString);
  if (Number.isNaN(dt.getTime())) return isoString;
  return dt.toLocaleString('hu-HU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Backend vagy hálózati hibaüzenetek lefordítása barátságos, tegező magyar szövegre.
 */
export function translateBackendError(error: unknown, fallbackStatus?: number): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';

  const lower = raw.toLowerCase();

  if (
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('network error') ||
    lower.includes('load failed')
  ) {
    return 'Nem sikerült elérni a helyi háttérprogramot. Ellenőrizd a kapcsolatot, majd próbáld újra.';
  }

  if (lower.includes('timeout') || lower.includes('timed out')) {
    return 'A művelet túl sokáig tartott. Próbáld meg újra egy pillanat múlva.';
  }

  if (lower.includes('not found') || fallbackStatus === 404) {
    return raw && /[áéíóöőúüű]/i.test(raw)
      ? raw
      : 'A keresett személy, kapcsolat vagy kép már nem található.';
  }

  if (fallbackStatus === 413 || lower.includes('too large')) {
    return 'A feltöltött fájl túl nagy. Válassz egy kisebb méretű fájlt.';
  }

  if (fallbackStatus === 409) {
    return raw && /[áéíóöőúüű]/i.test(raw)
      ? raw
      : 'Ez a kapcsolat ütközik egy meglévő családfabeli szabállyal.';
  }

  if (lower.includes('internal server error') || fallbackStatus === 500) {
    return 'Váratlan belső hiba történt a mentés közben. Próbáld meg újra.';
  }

  if (lower.includes('bad gateway') || fallbackStatus === 502 || fallbackStatus === 503) {
    return 'A háttérszolgáltatás éppen indul vagy ideiglenesen nem elérhető. Várj néhány másodpercet, majd próbáld újra.';
  }

  if (lower.includes('unauthorized') || lower.includes('forbidden')) {
    return 'Nincs jogosultságod a művelet végrehajtásához.';
  }

  if (raw && /[áéíóöőúüű]/i.test(raw)) {
    return raw;
  }

  if (raw && !/^[a-z0-9_.\-: ]+$/i.test(raw)) {
    return raw;
  }

  return 'Váratlan hiba történt a művelet közben. Próbáld meg újra.';
}
