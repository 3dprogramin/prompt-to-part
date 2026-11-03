import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * The last line of defence: an error while drawing the app shows a plain panel with the message
 * and a Reload button, rather than a blank page. Saved designs are on the server, so reloading
 * reopens the design (from ?design= in the URL).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Jig crashed while drawing the page', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash" role="alert">
        <div className="crash-panel">
          <h1>Something went wrong in Jig</h1>
          <p className="dim">Reload the page to carry on. Saved designs are kept; a change made in the last moment may not be.</p>
          <pre className="crash-error">{error.message || String(error)}</pre>
          <button className="btn primary" onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}
