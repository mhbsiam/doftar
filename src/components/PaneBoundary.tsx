import { Component, type ReactNode } from "react";
import { describeError, logUiError } from "../util/uiErrors";

interface Props {
  /** What failed, for the message: "this tab", "the preview". */
  what: string;
  /** A change clears the fault, so going elsewhere recovers without a click. */
  resetKey?: string;
  /** Shown above the message, when the part that failed held the window's only close button. */
  chrome?: ReactNode;
  children: ReactNode;
}

/** Keeps a rendering fault inside one part of the window. Without it React unmounts everything. */
export class PaneBoundary extends Component<Props, { error: unknown; at?: string }> {
  state: { error: unknown; at?: string } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: { error: unknown; at?: string }) {
    return props.resetKey === state.at ? null : { error: null, at: props.resetKey };
  }

  componentDidCatch(error: unknown) {
    logUiError("render", error);
  }

  render() {
    if (this.state.error === null) return this.props.children;
    return (
      <>
        {this.props.chrome}
        <div className="pane-fault" role="alert">
          <h2>Something went wrong showing {this.props.what}</h2>
          <p>Your files are not affected. The details are in Help → Copy Diagnostic Info.</p>
          <pre>{describeError(this.state.error).split("\n")[0]}</pre>
          <button className="btn accent" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      </>
    );
  }
}
