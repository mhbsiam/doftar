import {
  TextBulletListLtrRegular,
  GridDotsRegular,
} from "@fluentui/react-icons";
import { useActiveTab, useTabs } from "../stores/tabs";
import { setFolderView, useFolderView } from "../hooks/useFolderView";
import { formatSize } from "../util/format";
import { RollingNumber } from "./RollingNumber";

export function StatusBar() {
  const tab = useActiveTab();
  const listingCount = useTabs((s) => s.listingCount);
  const selectionBytes = useTabs((s) => s.selectionBytes);
  const { viewMode } = useFolderView();
  const selCount = tab.selection.length;

  return (
    <div className="statusbar">
      {/* Only the counts are live; the view buttons beside them are not news. */}
      <span className="status-counts" role="status">
        <span>
          {listingCount > 0 && (
            <>
              <RollingNumber value={listingCount} /> item{listingCount === 1 ? "" : "s"}
            </>
          )}
        </span>
        {selCount > 0 && (
          <span>
            <RollingNumber value={selCount} /> item{selCount === 1 ? "" : "s"} selected
            {selectionBytes > 0 && `  (${formatSize(selectionBytes)})`}
          </span>
        )}
      </span>
      <span className="status-right">
        <button
          className={`viewtoggle${viewMode === "details" ? " active" : ""}`}
          title="Details view"
          aria-label="Details view"
          aria-pressed={viewMode === "details"}
          onClick={() => setFolderView({ viewMode: "details" })}
        >
          <TextBulletListLtrRegular />
        </button>
        <button
          className={`viewtoggle${viewMode === "grid" ? " active" : ""}`}
          title="Large icons view"
          aria-label="Large icons view"
          aria-pressed={viewMode === "grid"}
          onClick={() => setFolderView({ viewMode: "grid" })}
        >
          <GridDotsRegular />
        </button>
      </span>
    </div>
  );
}
