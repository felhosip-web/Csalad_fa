import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronRight, RefreshCw, X } from 'lucide-react';
import type { AppErrorInfo } from '../types/family';

interface ErrorModalProps {
  error: AppErrorInfo;
  onClose: () => void;
}

export function ErrorModal({ error, onClose }: ErrorModalProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const okButtonRef = useRef<HTMLButtonElement | null>(null);
  const latestErrorRef = useRef(error);

  useEffect(() => {
    latestErrorRef.current = error;
    setDetailsOpen(false);
  }, [error]);

  useEffect(() => {
    okButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        if (!retrying) {
          onClose();
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose, retrying]);

  async function handleRetry() {
    const retryFn = error.onRetry;
    if (!retryFn || retrying) return;
    const startError = error;
    setRetrying(true);
    try {
      await retryFn();
      if (latestErrorRef.current === startError) {
        onClose();
      }
    } catch {
      if (latestErrorRef.current === startError) {
        onClose();
      }
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/45 p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="error-modal-title"
      aria-describedby="error-modal-desc"
    >
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-700">
              <AlertCircle className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h3 id="error-modal-title" className="text-base font-semibold text-slate-900">
                {error.title || 'Hiba történt'}
              </h3>
              <p id="error-modal-desc" className="mt-1.5 text-sm leading-relaxed text-slate-700">
                {error.message}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={retrying}
            title="Hibaablak bezárása (Esc)"
            aria-label="Hibaablak bezárása"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {error.hint && (
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-700">
            <span className="font-semibold text-slate-800">Javaslat: </span>
            {error.hint}
          </div>
        )}

        <div className="mt-4">
          <button
            type="button"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((prev) => !prev)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
          >
            {detailsOpen ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            Technikai részletek
          </button>

          {detailsOpen && (
            <div className="mt-2 space-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-600">
              <div>Hibakód: {error.code || 'UNEXPECTED_ERROR'}</div>
              {typeof error.status === 'number' && error.status > 0 && (
                <div>HTTP állapot: {error.status}</div>
              )}
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center justify-end gap-2.5">
          {error.onRetry && (
            <button
              type="button"
              onClick={() => void handleRetry()}
              disabled={retrying}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${retrying ? 'animate-spin' : ''}`} />
              {retrying ? 'Próbálkozás...' : 'Újrapróbálás'}
            </button>
          )}
          <button
            ref={okButtonRef}
            type="button"
            onClick={onClose}
            disabled={retrying}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            Rendben
          </button>
        </div>
      </div>
    </div>
  );
}
