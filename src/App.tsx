import { useEffect, useLayoutEffect } from "react";
import { FluentProvider } from "@fluentui/react-components";
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
import { StatusBar } from "./components/StatusBar";
import { ContextMenuHost } from "./components/ContextMenu";
import { DialogHost } from "./components/Dialogs";
import { ToastHost } from "./components/Toasts";
import { DragGhost } from "./components/DragGhost";

/**
 * One explorer: tabs, address bar, commands, navigation pane, listing and
 * status bar. Split view shows two; the right one mirrors the left, with its
 * navigation pane on the far side.
 */
function Pane({ pane }: { pane: number }) {
  const focused = usePanes((s) => s.focused === pane);
  return (
    <PaneContext.Provider value={pane}>
      <div
        className={`pane${pane === 1 ? " mirrored" : ""}${focused ? " focused" : ""}`}
        data-pane={pane}
        // Commands, shortcuts and paste act on the pane last pressed or tabbed into.
        onPointerDownCapture={() => focusPane(pane)}
        onFocusCapture={() => focusPane(pane)}
      >
        <PaneBody pane={pane} />
      </div>
    </PaneContext.Provider>
  );
}

function PaneBody({ pane }: { pane: number }) {
  const navPaneHidden = useTabs((s) => s.navPaneHidden);
  const activeTabId = useTabs((s) => s.activeId);
  return (
    <>
      <TitleBar />
      <AddressBar />
      <CommandBar />
      <div className="main">
        {!navPaneHidden && <NavPane />}
        {/* The main landmark doubles as the tab strip's panel, named by the active tab. */}
        <main
          className="content-frame"
          id={`wf-tabpanel-${pane}`}
          aria-labelledby={`wf-tab-title-${activeTabId}`}
        >
          <ContentArea />
        </main>
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

  // The accent follows the default folder color (see util/accent.ts).
  const folderColor = useSettings((s) => s.folderColor);
  useLayoutEffect(() => {
    const root = document.documentElement;
    for (const [name, value] of Object.entries(accentFor(folderColor, theme).vars)) {
      root.style.setProperty(name, value);
    }
  }, [folderColor, theme]);

  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onFocusChanged(({ payload: focused }) => {
      const root = document.documentElement;
      // A window in the background shows its selection in grey, as on macOS.
      root.toggleAttribute("data-inactive", !focused);
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
    <FluentProvider theme={fluentTheme(theme, folderColor)}>
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
