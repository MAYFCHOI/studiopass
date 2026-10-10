import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidUpdate(prev: { resetKey: string }) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }); }
  render() {
    if (!this.state.error) return this.props.children;
    const e = this.state.error;
    return (
      <div className="empty" style={{ textAlign: 'left' }}>
        <b>화면을 그리다 문제가 생겼어요</b>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: 'var(--danger)', background: 'var(--surface)', padding: 12, borderRadius: 12 }}>{e.message}{'\n'}{(e.stack ?? '').split('\n').slice(1, 4).join('\n')}</pre>
        <div className="btn-row">
          <button className="btn" onClick={() => this.setState({ error: null })}>다시 시도</button>
          <button className="btn ghost" onClick={() => { localStorage.removeItem('studiopass-v1'); location.reload(); }}>데모 데이터로 초기화</button>
        </div>
      </div>
    );
  }
}
