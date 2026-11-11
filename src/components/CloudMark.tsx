import { CheckmarkCircleFilled, CloudRegular } from "@fluentui/react-icons";
import { inCloudDrive, useAppData } from "../stores/appdata";
import { useDownloads } from "../stores/downloads";
import type { FileEntry } from "../types";

const R = 5;
const RING = 2 * Math.PI * R;

export function CloudMark({ entry }: { entry: FileEntry }) {
  const fraction = useDownloads((s) => s[entry.path]);
  const cloud = useAppData((s) => !entry.isDir && inCloudDrive([entry.path], s.cloudDrives) !== undefined);
  if (!cloud) return null;
  if (fraction !== undefined) {
    const pct = Math.round(fraction * 100);
    return (
      <span
        className="cloud-mark downloading"
        title={`Downloading, ${pct}%`}
        role="progressbar"
        aria-label="Downloading"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <svg viewBox="0 0 14 14" width="1em" height="1em" aria-hidden>
          <circle cx="7" cy="7" r={R} className="track" />
          <circle cx="7" cy="7" r={R} className="fill" strokeDasharray={RING} strokeDashoffset={RING * (1 - fraction)} />
        </svg>
      </span>
    );
  }
  const title = entry.isDataless ? "Online only: downloads when opened" : "Downloaded to this Mac";
  return (
    <span className={`cloud-mark ${entry.isDataless ? "online" : "local"}`} title={title} role="img" aria-label={title}>
      {entry.isDataless ? <CloudRegular /> : <CheckmarkCircleFilled />}
    </span>
  );
}
