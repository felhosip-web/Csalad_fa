import type { HealthResponse } from '../types/family';

interface ContractPanelProps {
  health: HealthResponse | null;
}

const ENDPOINTS = [
  { method: 'GET', path: '/api/health', desc: 'Backend állapot, SQLite motor és Pillow támogatás' },
  { method: 'GET', path: '/api/tree?search=...', desc: 'Teljes családfa pillanatkép (meta, persons, unions, parent_child)' },
  { method: 'PATCH', path: '/api/tree/meta', desc: 'Családfa nevének átírása' },
  { method: 'GET', path: '/api/persons', desc: 'Személyek listázása / keresése név és születési név alapján' },
  { method: 'POST', path: '/api/persons', desc: 'Új személy létrehozása részleges dátum-validációval' },
  { method: 'GET', path: '/api/persons/{id}', desc: 'Személy részletes csomagja (szülők, kapcsolatok, testvérek, féltestvérek)' },
  { method: 'PATCH', path: '/api/persons/{id}', desc: 'Személy adatainak részleges frissítése' },
  { method: 'POST', path: '/api/persons/{id}/quick-parent', desc: 'Gyors szülő létrehozása és összekapcsolása' },
  { method: 'POST', path: '/api/persons/{id}/quick-child', desc: 'Gyors gyermek létrehozása (kapcsolathoz kötve)' },
  { method: 'POST', path: '/api/persons/{id}/quick-partner', desc: 'Gyors partner és union kapcsolat felvétele' },
  { method: 'POST', path: '/api/persons/{id}/avatar', desc: 'Portré feltöltése és optimalizálása' },
  { method: 'POST', path: '/api/relations', desc: 'Szülő-gyermek él felvétele ciklus-ellenőrzéssel' },
  { method: 'GET', path: '/api/package/export', desc: 'Hordozható .ftree (ZIP) csomag letöltése' },
  { method: 'POST', path: '/api/package/import', desc: '.ftree (ZIP) csomag biztonságos betöltése és migrációja' },
];

export function ContractPanel({ health }: ContractPanelProps) {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Adatbázis-séma és REST API szerződés</h2>
        <p className="mt-1 text-sm text-slate-600">
          Az első fázis stabil, tesztelhető alapja a Python SQLite réteg és a React kliens között.
        </p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <h3 className="text-sm font-semibold text-slate-900">Futási környezet</h3>
        <div className="mt-3 grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
          <div>
            <div className="text-xs text-slate-500">Backend motor</div>
            <div className="mt-0.5 font-mono text-slate-900">{health?.engine ?? '—'}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">API verzió</div>
            <div className="mt-0.5 font-mono tabular-nums text-slate-900">
              {health?.version ?? '—'}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500">Pillow portréoptimalizálás</div>
            <div className="mt-0.5 font-medium text-slate-900">
              {health?.pillow_available
                ? 'Aktív (EXIF + WebP/JPEG 512px)'
                : 'Alap mód (magic-byte validáció)'}
            </div>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-5 py-3.5">
          <h3 className="text-sm font-semibold text-slate-900">Végpontok</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="px-5 py-2.5 font-medium">Metódus</th>
                <th className="px-5 py-2.5 font-medium">Útvonal</th>
                <th className="px-5 py-2.5 font-medium">Feladat</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {ENDPOINTS.map((ep) => (
                <tr key={`${ep.method}-${ep.path}`} className="hover:bg-slate-50">
                  <td className="px-5 py-2.5 font-mono font-medium text-emerald-700">{ep.method}</td>
                  <td className="px-5 py-2.5 font-mono text-slate-900">{ep.path}</td>
                  <td className="px-5 py-2.5 text-slate-600">{ep.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
