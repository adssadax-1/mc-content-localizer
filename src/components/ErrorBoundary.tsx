import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 全局错误边界：任何渲染/副作用异常都不再让窗口变成永久白屏，
 * 而是给出错误摘要与「重新加载 / 重置会话」两个恢复入口。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 保留现场：控制台可见完整调用栈（开发者工具版可进一步排查）
    console.error("[ui-error]", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        style={{
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          padding: 24,
          fontFamily: "system-ui, sans-serif",
          color: "var(--ant-color-text, #1f1f1f)",
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600 }}>界面出现异常，已停止渲染</div>
        <div style={{ fontSize: 13, opacity: 0.75, maxWidth: 640, textAlign: "center" }}>
          内容包列表已自动缓存，重新加载后可选择恢复（含已汉化的内容）。
        </div>
        <pre
          style={{
            maxWidth: 720,
            maxHeight: 200,
            overflow: "auto",
            fontSize: 12,
            background: "rgba(127,127,127,0.12)",
            padding: 12,
            borderRadius: 8,
            whiteSpace: "pre-wrap",
          }}
        >
          {String(error?.message ?? error)}
        </pre>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ padding: "6px 14px", borderRadius: 6, cursor: "pointer" }}
          >
            返回界面
          </button>
          <button
            onClick={() => window.location.reload()}
            style={{ padding: "6px 14px", borderRadius: 6, cursor: "pointer" }}
          >
            重新加载
          </button>
        </div>
      </div>
    );
  }
}
