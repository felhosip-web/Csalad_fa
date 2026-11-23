import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorModal } from './ErrorModal';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  modalOpen: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    modalOpen: false,
  };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return {
      hasError: true,
      modalOpen: true,
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Váratlan felületi hiba történt:', error, info);
  }

  private handleReset = () => {
    this.setState({ hasError: false, modalOpen: false });
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-slate-900">
            Váratlan felületi hiba
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            A felület megjelenítése közben váratlan hiba történt. A családfa adatai biztonságban vannak, próbáld meg újratölteni a nézetet.
          </p>
          <div className="mt-5 flex items-center justify-center gap-2.5">
            <button
              type="button"
              onClick={this.handleReset}
              className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 whitespace-nowrap shrink-0"
            >
              Nézet újratöltése
            </button>
          </div>
        </div>

        {this.state.modalOpen && (
          <ErrorModal
            error={{
              title: 'Váratlan felületi hiba',
              message:
                'A felület megjelenítése közben váratlan hiba történt. A családfa adatai biztonságban vannak, próbáld meg újratölteni a nézetet.',
              hint: 'Ha a hiba ismétlődik, frissítsd a böngészőablakot.',
              code: 'UI_RENDER_ERROR',
              onRetry: this.handleReset,
            }}
            onClose={() => this.setState({ modalOpen: false })}
          />
        )}
      </div>
    );
  }
}
