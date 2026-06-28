import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  title?: string;
  children: ReactNode;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[doctor-analytics] render error', error, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    if (this.state.error) {
      return (
        <section className="card border-rose-200 bg-rose-50 p-4">
          <h2 className="text-sm font-bold text-rose-800">{this.props.title || 'Something went wrong'}</h2>
          <p className="mt-2 text-sm text-rose-700">{this.state.error.message}</p>
          <button type="button" className="btn mt-3" onClick={this.handleReset}>
            Try again
          </button>
        </section>
      );
    }
    return this.props.children;
  }
}
