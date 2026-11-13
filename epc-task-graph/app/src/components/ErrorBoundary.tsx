import { Component, type ErrorInfo, type ReactNode } from "react";
import { useApp } from "../store/store";
import { downloadJson } from "../store/backup";

interface State {
  error: Error | null;
}

// 描画中の例外で画面が真っ白になるのを防ぐ。デプロイ直後に古い遅延チャンクの読込が失敗する場合も、再読み込みで復帰できる。
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("ErrorBoundary caught:", error, info.componentStack);
  }

  private exportData = () => {
    try {
      downloadJson(useApp.getState().toDoc());
    } catch {
      alert("データを書き出せませんでした。再読み込み後にもう一度お試しください。");
    }
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-boundary" role="alert">
        <h1>問題が発生しました</h1>
        <p className="error-boundary-msg">{error.message}</p>
        <div className="error-boundary-actions">
          <button className="btn" onClick={() => location.reload()}>
            再読み込み
          </button>
          <button className="btn" onClick={this.exportData}>
            データをJSONで書き出す
          </button>
        </div>
      </div>
    );
  }
}
