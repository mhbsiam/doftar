import { FolderTreeSlot } from "./components/FolderTree";
import { PreviewSlot } from "./components/PreviewPane";
import { useEffect, useLayoutEffect, useRef, type SyntheticEvent } from "react";
import { FluentProvider } from "@fluentui/react-components";
import { ArrowLeftRegular, ArrowRightRegular } from "@fluentui/react-icons";
import { fluentTheme } from "./fluentTheme";
import { accentFor } from "./util/accent";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppData } from "./stores/appdata";
import { PaneContext, focusPane, usePanes, useTabs } from "./stores/tabs";
import { useShortcuts } from "./hooks/useShortcuts";
import { useMenuEvents } from "./hooks/useMenuEvents";
import { useResolvedTheme } from "./hooks/useResolvedTheme";
import { useDragDrop } from "./hooks/useDragDrop";
import { useSettings } from "./stores/settings";
import { useHoverPrefetch } from "./hooks/useHoverPrefetch";
import { TitleBar } from "./components/TitleBar";
import { CommandBar } from "./components/CommandBar";
import { AddressBar } from "./components/AddressBar";
import { NavPane } from "./components/NavPane";
import { ContentArea } from "./components/ContentArea";
import { PaneBoundary } from "./components/PaneBoundary";
import { StatusBar } from "./components/StatusBar";
import { ContextMenuHost } from "./components/ContextMenu";
import { DialogHost } from "./components/Dialogs";
import { ToastHost } from "./components/Toasts";
import { DragGhost } from "./components/DragGhost";

function Pane({ pane }: { pane: number }) {
  const focused = usePanes((s) => s.focused === pane);
  // The preview may show the other half's file, so using it leaves the focus on that half.
  const focusUnlessPreview = (e: SyntheticEvent) => {
    if (!(e.target as Element).closest(".preview-slot")) focusPane(pane);
  };
  return (
    <PaneContext.Provider value={pane}>
      <div
        className={`pane${focused ? " focused" : ""}`}
        data-pane={pane}
        // Commands, shortcuts and paste act on the pane that last got focus.
        onPointerDownCapture={focusUnlessPreview}
        onFocusCapture={focusUnlessPreview}
      >
        <PaneBody pane={pane} />
      </div>
    </PaneContext.Provider>
  );
}

function PaneBody({ pane }: { pane: number }) {
  // The preview takes the right half's navigation pane away, to leave the listings room. Closing it shows the pane again.
  const navClosed = useTabs((s) => s.navPaneHidden || (pane === 1 && s.previewOpen));
  const activeTabId = useTabs((s) => s.activeId);
  // Keep the pane mounted so it can slide shut. A closed pane cannot take focus.
  const navSlot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (navSlot.current) navSlot.current.inert = navClosed;
  }, [navClosed]);
  return (
    <>
      <TitleBar />
      <AddressBar />
      <CommandBar />
      <div className="main">
        <div
          ref={navSlot}
          className={`navpane-slot${navClosed ? " closed" : ""}`}
          aria-hidden={navClosed || undefined}
        >
          <PaneBoundary what="the navigation pane">
            <NavPane />
          </PaneBoundary>
        </div>
        {/* The main landmark is also the tab panel. The active tab names it. */}
        <main
          className="content-frame"
          id={`wf-tabpanel-${pane}`}
          aria-labelledby={`wf-tab-title-${activeTabId}`}
        >
          <ContentArea />
          {/* useShortcuts shows it during a two-finger swipe. */}
          <div className="swipe-cue" aria-hidden="true">
            <ArrowLeftRegular className="swipe-back" />
            <ArrowRightRegular className="swipe-forward" />
          </div>
        </main>
        <PaneBoundary what="the side panel">
          <FolderTreeSlot pane={pane} />
          <PreviewSlot />
        </PaneBoundary>
      </div>
      <StatusBar />
    </>
  );
}

export default function App() {
  const theme = useResolvedTheme();
  const split = usePanes((s) => s.split);
  useShortcuts();
  useMenuEvents();
  useDragDrop();
  useHoverPrefetch();

  useEffect(() => {
    void useAppData.getState().init();
  }, []);

  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // The accent follows the default folder color, unless a selection color is set. See util/accent.ts.
  const accentColor = useSettings((s) => s.selectionColor ?? s.folderColor);
  useLayoutEffect(() => {
    const root = document.documentElement;
    for (const [name, value] of Object.entries(accentFor(accentColor, theme).vars)) {
      root.style.setProperty(name, value);
    }
  }, [accentColor, theme]);

  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onFocusChanged(({ payload: focused }) => {
      const root = document.documentElement;
      if (!focused) return;
      root.style.transform = "translateZ(0)";
      requestAnimationFrame(() => {
        root.style.transform = "";
      });
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  return (
    <FluentProvider theme={fluentTheme(theme, accentColor)}>
      <div className={`app${split ? " split" : ""}`}>
        <Pane pane={0} />
        {split && <Pane pane={1} />}
      </div>
      <ContextMenuHost />
      <DialogHost />
      <ToastHost />
      <DragGhost />
    </FluentProvider>
  );
}
