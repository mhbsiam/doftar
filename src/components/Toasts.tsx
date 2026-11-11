import { useEffect, useState } from "react";
import { DismissRegular } from "@fluentui/react-icons";
import { useUI, type Toast } from "../stores/ui";
import { useJobs, type JobInfo } from "../stores/jobs";
import { cancelJob, pauseJob } from "../jobs";
import { formatSize } from "../util/format";

const LIFETIME_MS = 7000;
// Toasts with an action, or an error, stay longer. The user needs time to read them and reach the button.
const LONG_LIFETIME_MS = 12000;

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useUI((s) => s.dismissToast);
  const [leaving, setLeaving] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const lifetime = toast.action || toast.tone === "error" ? LONG_LIFETIME_MS : LIFETIME_MS;
  // Hover or focus holds a toast open. The full lifetime restarts after.
  const paused = hovered || focused;
  useEffect(() => {
    if (paused || leaving) return;
    const t = setTimeout(() => setLeaving(true), lifetime);
    return () => clearTimeout(t);
  }, [toast.id, paused, leaving, lifetime]);
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => dismiss(toast.id), 400);
    return () => clearTimeout(t);
  }, [leaving, toast.id, dismiss]);
  return (
    <div
      className={`toast${leaving ? " leaving" : ""}`}
      role={toast.tone === "error" ? "alert" : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      onAnimationEnd={(e) => {
        if (leaving && e.target === e.currentTarget) dismiss(toast.id);
      }}
    >
      <span className="toast-msg">{toast.message}</span>
      {toast.action && (
        <button
          className="toast-action"
          onClick={() => {
            toast.action?.onClick();
            setLeaving(true);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        className="toast-close"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={() => setLeaving(true)}
      >
        <DismissRegular />
      </button>
    </div>
  );
}

function formatEta(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s left`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min left`;
  return `${(seconds / 3600).toFixed(1)} h left`;
}

function JobCard({ job }: { job: JobInfo }) {
  const p = job.progress;
  const known = !!p && p.bytesTotal > 0;
  const determinate = known && !p.scanning;
  const fraction = determinate ? Math.min(1, p.bytesDone / p.bytesTotal) : 0;
  const parts: string[] = [];
  if (p && p.bytesDone > 0) {
    parts.push(
      determinate
        ? `${formatSize(p.bytesDone)} of ${formatSize(p.bytesTotal)}`
        : formatSize(p.bytesDone)
    );
    if (job.rate > 0) parts.push(`${formatSize(job.rate)}/s`);
    if (determinate && job.rate > 0) {
      parts.push(formatEta((p.bytesTotal - p.bytesDone) / job.rate));
    }
  } else if (p && p.itemsTotal > 1) {
    parts.push(`${p.itemsDone} of ${p.itemsTotal} items`);
  }
  return (
    <div className="toast job" role="status" aria-live="off">
      <div className="job-main">
        <span className="toast-msg job-title">{job.title}</span>
        <div
          className={`job-bar${determinate ? "" : " indeterminate"}`}
          role="progressbar"
          aria-label={job.title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={determinate ? Math.round(fraction * 100) : undefined}
        >
          <div
            className="job-fill"
            style={determinate ? { transform: `scaleX(${fraction})` } : undefined}
          />
        </div>
        <span className="job-detail">
          {job.cancelling ? "Cancelling…" : p?.paused ? `Paused · ${parts[0] ?? p.current}` : p?.current.startsWith("Verifying ") ? p.current : parts.join(" · ") || p?.current || "Preparing…"}
        </span>
      </div>
      {job.pausable && (
        <button
          className="toast-action"
          disabled={job.cancelling || !p}
          onClick={() => pauseJob(job.id, !p?.paused)}
        >
          {p?.paused ? "Resume" : "Pause"}
        </button>
      )}
      <button
        className="toast-action"
        disabled={job.cancelling}
        onClick={() => cancelJob(job.id)}
      >
        Cancel
      </button>
    </div>
  );
}

export function ToastHost() {
  const toasts = useUI((s) => s.toasts);
  const jobs = useJobs((s) => s.jobs).filter((j) => j.shown);
  // Keep the stack mounted. Screen readers need a live region to announce new toasts from.
  // Job cards opt out with aria-live="off".
  return (
    <div className="toast-stack" aria-live="polite" aria-relevant="additions">
      {jobs.map((j) => (
        <JobCard key={j.id} job={j} />
      ))}
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
