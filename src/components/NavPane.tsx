import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../ipc";
import { useShallow } from "zustand/react/shallow";
import { useRovingFocus } from "../hooks/useRovingFocus";
import {
  bundleIcon,
  ArrowEjectRegular,
  ChevronDownRegular,
  AppsFilled,
  AppsRegular,
  BranchFilled,
  BranchRegular,
  ArrowDownloadFilled,
  ArrowDownloadRegular,
  CloudFilled,
  CloudRegular,
  DataPieFilled,
  DataPieRegular,
  DesktopFilled,
  DesktopRegular,
  DocumentFilled,
  DocumentRegular,
  FolderFilled,
  FolderRegular,
  HomeFilled,
  HomeRegular,
  ImageFilled,
  ImageRegular,
  MusicNote2Filled,
  MusicNote2Regular,
  PersonFilled,
  PersonRegular,
  ScreenshotFilled,
  ScreenshotRegular,
  DiamondFilled,
  DiamondRegular,
  TagFilled,
  TagRegular,
  VideoClipFilled,
  VideoClipRegular,
  SearchFilled,
  SearchRegular,
} from "@fluentui/react-icons";
import {
  useAppData,
  type CloudDrive,
} from "../stores/appdata";
import { baseName, useActiveTab, useTabs } from "../stores/tabs";
import { useDropHover } from "../stores/drag";
import { useSettings } from "../stores/settings";
import { useSystemInfo } from "../hooks/useSystemInfo";
import { navigateTo, ejectVolume, emptyTrash, runSavedSearch, toggleSavedSearch } from "../actions";
import { useUI, type MenuItemSpec } from "../stores/ui";
import { TrashIcon, WinDriveIcon, WinNetworkDriveIcon, useFolderColor } from "./FileIcon";
import { TRASH_LIMIT_BYTES, useTrashSize } from "../hooks/useTrashSize";
import { formatSize } from "../util/format";
import type { FileEntry, Location, VolumeInfo } from "../types";

// The navigation pane shows the filled icon of a selected row (see .navicon in global.css).
const AppsIcon = bundleIcon(AppsFilled, AppsRegular);
const BranchIcon = bundleIcon(BranchFilled, BranchRegular);
const SkillsIcon = bundleIcon(DiamondFilled, DiamondRegular);
const SearchIcon = bundleIcon(SearchFilled, SearchRegular);
const ArrowDownloadIcon = bundleIcon(ArrowDownloadFilled, ArrowDownloadRegular);
const CloudIcon = bundleIcon(CloudFilled, CloudRegular);
const DataPieIcon = bundleIcon(DataPieFilled, DataPieRegular);
const DesktopIcon = bundleIcon(DesktopFilled, DesktopRegular);
const DocumentIcon = bundleIcon(DocumentFilled, DocumentRegular);
const FolderIcon = bundleIcon(FolderFilled, FolderRegular);
const HomeIcon = bundleIcon(HomeFilled, HomeRegular);
const ImageIcon = bundleIcon(ImageFilled, ImageRegular);
const MusicIcon = bundleIcon(MusicNote2Filled, MusicNote2Regular);
const ScreenshotIcon = bundleIcon(ScreenshotFilled, ScreenshotRegular);
const VideoIcon = bundleIcon(VideoClipFilled, VideoClipRegular);
const PersonIcon = bundleIcon(PersonFilled, PersonRegular);
const TagIcon = bundleIcon(TagFilled, TagRegular);

function fileExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function folderEntry(path: string): FileEntry {
  return {
    name: baseName(path),
    path,
    isDir: true,
    isHidden: false,
    isSymlink: false,
    isPackage: false,
    size: 0,
    modifiedMs: 0,
    createdMs: 0,
    ext: "",
  };
}

type SectionKey = "quick" | "drives" | "network" | "cloud" | "favorites" | "searches" | "tools";

const HIDDEN_VOLUME_NAMES = new Set(["Recovery", "Preboot", "VM", "Update"]);

const QUICK_ICONS: Record<string, React.ReactNode> = {
  Desktop: <DesktopIcon />,
  Documents: <DocumentIcon />,
  Downloads: <ArrowDownloadIcon />,
  Movies: <VideoIcon />,
  Music: <MusicIcon />,
  Pictures: <ImageIcon />,
};

function unhideQuickAccess(): MenuItemSpec {
  const hidden = useSettings.getState().hiddenQuickAccess;
  const names = [...useAppData.getState().pins.map(baseName), "Screenshots"];
  return {
    key: "unhide",
    label: "Unhide all",
    disabled: !names.some((n) => hidden.includes(n)),
    onSelect: () => useSettings.getState().unhideQuickAccess(),
  };
}

function unhidePlaces(): MenuItemSpec {
  return {
    key: "unhide",
    label: "Unhide all",
    disabled: useSettings.getState().hiddenPlaces.length === 0,
    onSelect: () => useSettings.getState().unhidePlaces(),
  };
}

const PAGES: { kind: "disk" | "tags" | "skills" | "repos"; label: string; icon: React.ReactElement; title: string }[] = [
  { kind: "disk", label: "Disk", icon: <DataPieIcon />, title: "Disk usage" },
  { kind: "tags", label: "Tags", icon: <TagIcon />, title: "Tagged items" },
  { kind: "skills", label: "Skills", icon: <SkillsIcon />, title: "Agent skills" },
  { kind: "repos", label: "Git", icon: <BranchIcon />, title: "Git repositories" },
];

/** Pages that are tools, not places. They share one section, so the places above stay short. */
const TOOL_PAGES: (typeof PAGES)[number]["kind"][] = ["disk", "skills", "repos"];

function placeMenu(open: () => void, kind?: Location["kind"]): MenuItemSpec[] {
  return [
    { key: "open", label: "Open", onSelect: open },
    ...(kind
      ? [{ key: "hide", label: "Hide", dividerBefore: true, onSelect: () => useSettings.getState().hidePlace(kind) }]
      : []),
    { ...unhidePlaces(), dividerBefore: !kind },
  ];
}

function quickAccessMenu(name: string, open: () => void): MenuItemSpec[] {
  return [
    { key: "open", label: "Open", onSelect: open },
    {
      key: "hide",
      label: "Hide",
      dividerBefore: true,
      onSelect: () => useSettings.getState().hideQuickAccess(name),
    },
    unhideQuickAccess(),
  ];
}

function NavSection(props: {
  title: string;
  open: boolean;
  onToggle: () => void;
  drop?: string;
  menu?: () => MenuItemSpec[];
  children: React.ReactNode;
}) {
  const { title, open, onToggle, drop, menu, children } = props;
  const hover = useDropHover(drop);
  const [revealed, setRevealed] = useState(false);
  return (
    <div
      className={`navsection${revealed && open ? " opened" : ""}${hover ? " drop-hover" : ""}`}
      data-drop={drop}
    >
      <button
        className="navsection-h"
        aria-expanded={open}
        title={open ? `Collapse ${title}` : `Expand ${title}`}
        onClick={() => {
          if (!open) setRevealed(true);
          onToggle();
        }}
        onContextMenu={
          menu
            ? (e) => {
                e.preventDefault();
                useUI.getState().openContextMenu(e.clientX, e.clientY, menu());
              }
            : undefined
        }
      >
        <span className="lbl">{title}</span>
        <span className={`navchev sec${open ? " open" : ""}`} aria-hidden>
          <ChevronDownRegular />
        </span>
      </button>
      {open && children}
    </div>
  );
}

function NavRow(props: {
  label: string;
  icon: React.ReactNode;
  selected?: boolean;
  onClick?: () => void;
  actionIcon?: React.ReactNode;
  actionTitle?: string;
  onAction?: () => void;
  title?: string;
  drop?: string;
  menu?: () => MenuItemSpec[];
}) {
  const {
    label,
    icon,
    selected,
    onClick,
    actionIcon,
    actionTitle,
    onAction,
    title,
    drop,
    menu,
  } = props;
  const dropKey = drop ? `nav|${drop}` : undefined;
  const hover = useDropHover(dropKey);
  return (
    <div
      className={`navrow${selected ? " selected" : ""}${hover ? " drop-hover" : ""}`}
      title={title}
      data-drop={dropKey}
      onContextMenu={
        menu
          ? (e) => {
              e.preventDefault();
              useUI.getState().openContextMenu(e.clientX, e.clientY, menu());
            }
          : undefined
      }
    >
      <button
        className="navmain"
        aria-current={selected ? "page" : undefined}
        onClick={onClick}
      >
        <span className="navicon" aria-hidden>
          {icon}
        </span>
        <span className="navlabel">{label}</span>
      </button>
      {actionIcon && (
        <button
          className="navpin"
          tabIndex={-1}
          title={actionTitle}
          aria-label={`${actionTitle}: ${label}`}
          onClick={onAction}
        >
          {actionIcon}
        </button>
      )}
    </div>
  );
}

export function NavPane() {
  const info = useSystemInfo();
  // Only what the pane shows: recents change on every navigation and must not redraw it.
  const appdata = useAppData(
    useShallow((s) => ({
      home: s.home,
      cloudDrives: s.cloudDrives,
      pins: s.pins,
      favorites: s.favorites,
      toggleFavorite: s.toggleFavorite,
    }))
  );
  const tab = useActiveTab();
  const collapsed = useSettings((s) => s.collapsedSections);
  const toggle = useSettings((s) => s.toggleSection);
  const isOpen = (key: SectionKey) => !collapsed.includes(`nav:${key}`);
  const toggleSection = (key: SectionKey) => toggle(`nav:${key}`);

  const activePath = tab.location.kind === "path" ? tab.location.path : null;
  const home = appdata.home;
  const hiddenPlaces = useSettings((s) => s.hiddenPlaces);
  // Skills is for people who use coding agents: shown only when an agent folder exists (checked at launch).
  const [hasAgents, setHasAgents] = useState(false);
  useEffect(() => {
    api
      .listSkills()
      .then((places) => setHasAgents(places.length > 0))
      .catch(() => {});
  }, []);
  const savedSearches = useSettings((s) => s.savedSearches);
  const trashPath = home ? `${home}/.Trash` : null;
  const trashBytes = useTrashSize(trashPath);
  const trashColor = useFolderColor(trashPath ?? undefined);
  const volumes: VolumeInfo[] = (info?.volumes ?? []).filter(
    (v) => !HIDDEN_VOLUME_NAMES.has(v.name)
  );
  const localVolumes = volumes.filter((v) => !v.isNetwork);
  const networkVolumes = volumes.filter((v) => v.isNetwork);
  const hiddenCloud = useSettings((s) => s.hiddenCloudDrives);
  const cloudDrives: CloudDrive[] = appdata.cloudDrives.filter(
    (d) => !hiddenCloud.includes(d.path)
  );
  const hiddenCloudCount = appdata.cloudDrives.length - cloudDrives.length;
  const unhideAll: MenuItemSpec = {
    key: "unhide",
    label: "Unhide all",
    disabled: hiddenCloudCount === 0,
    onSelect: () => useSettings.getState().unhideCloudDrives(),
  };
  const cloudHeadingMenu = (): MenuItemSpec[] => [
    ...appdata.cloudDrives.map((d) => {
      const shown = !hiddenCloud.includes(d.path);
      return {
        key: `show:${d.path}`,
        label: d.name,
        checked: shown,
        onSelect: () =>
          shown
            ? useSettings.getState().hideCloudDrive(d.path)
            : useSettings.getState().unhideCloudDrive(d.path),
      };
    }),
    { ...unhideAll, dividerBefore: true },
  ];
  const cloudMenu = (drive: CloudDrive): MenuItemSpec[] => [
    {
      key: "open",
      label: "Open",
      onSelect: () => navigateTo({ kind: "path", path: drive.path }),
    },
    {
      key: "hide",
      label: "Hide",
      dividerBefore: true,
      onSelect: () => useSettings.getState().hideCloudDrive(drive.path),
    },
    unhideAll,
    {
      key: "props",
      label: "Properties",
      dividerBefore: true,
      onSelect: () => useUI.getState().openProperties(folderEntry(drive.path)),
    },
  ];
  const hiddenQuick = useSettings((s) => s.hiddenQuickAccess);
  const quickPins = appdata.pins.filter((p) => !hiddenQuick.includes(baseName(p)));
  const showScreenshots = !hiddenQuick.includes("Screenshots");
  const volumeRow = (vol: VolumeInfo) => (
    <NavRow
      key={vol.path}
      label={vol.name}
      icon={vol.isNetwork ? <WinNetworkDriveIcon size={20} /> : <WinDriveIcon size={20} />}
      selected={activePath === vol.path}
      onClick={() => navigateTo({ kind: "path", path: vol.path })}
      title={
        vol.totalBytes > 0
          ? `${vol.path}, ${Math.round(
              ((vol.totalBytes - vol.freeBytes) / vol.totalBytes) * 100
            )}% used`
          : vol.path
      }
      drop={`path:${vol.path}`}
      actionIcon={vol.ejectable ? <ArrowEjectRegular /> : undefined}
      actionTitle="Eject"
      onAction={() => ejectVolume(vol.path, vol.name)}
      menu={() => [
        {
          key: "open",
          label: "Open",
          onSelect: () => navigateTo({ kind: "path", path: vol.path }),
        },
        ...(vol.ejectable
          ? [
              {
                key: "eject",
                label: "Eject",
                icon: <ArrowEjectRegular />,
                dividerBefore: true,
                onSelect: () => ejectVolume(vol.path, vol.name),
              },
            ]
          : []),
      ]}
    />
  );

  const folderRow = (props: {
    key: string;
    label: string;
    path: string;
    icon?: React.ReactNode;
    menu?: () => MenuItemSpec[];
  }) => (
    <NavRow
      key={props.key}
      label={props.label}
      icon={props.icon ?? <FolderIcon />}
      selected={activePath === props.path}
      onClick={() => navigateTo({ kind: "path", path: props.path })}
      title={props.path}
      drop={`path:${props.path}`}
      menu={props.menu}
    />
  );

  // One Tab stop. Up and Down walk rows and section headers.
  // Left and Right collapse or expand a section, or reach the secondary button of a row.
  const navRef = useRef<HTMLElement>(null);

  // The highlight is one element. It slides from the old row to the new current row (see .glider in details view).
  // Rows that only move (a section opens, the pane resizes) catch up at once. It slides only when the current place changes.
  const gliderRef = useRef<HTMLDivElement>(null);
  const placeKey = `${tab.location.kind}:${activePath ?? ""}`;
  const gliderWas = useRef<string | null>(null);
  useLayoutEffect(() => {
    const nav = navRef.current;
    const glider = gliderRef.current;
    if (!nav || !glider) return;
    const place = (travel: boolean) => {
      const row = nav.querySelector<HTMLElement>(".navrow.selected");
      nav.classList.toggle("has-glider", row !== null);
      if (!row) {
        glider.classList.remove("on");
        gliderWas.current = null;
        return;
      }
      const a = nav.getBoundingClientRect();
      const b = row.getBoundingClientRect();
      const x = b.left - a.left - nav.clientLeft + nav.scrollLeft;
      const y = b.top - a.top - nav.clientTop + nav.scrollTop;
      const to = `translate(${x}px, ${y}px)`;
      const width = `${b.width}px`;
      const height = `${b.height}px`;
      gliderWas.current = placeKey;
      // A render that moved nothing does not stop a slide in progress.
      if (
        glider.classList.contains("on") &&
        glider.style.transform === to &&
        glider.style.width === width &&
        glider.style.height === height
      ) {
        return;
      }
      glider.classList.toggle("instant", !travel || !glider.classList.contains("on"));
      glider.style.width = width;
      glider.style.height = height;
      glider.style.transform = to;
      glider.classList.add("on");
    };
    place(gliderWas.current !== placeKey);
    const ro = new ResizeObserver(() => place(false));
    ro.observe(nav);
    return () => ro.disconnect();
  });
  const roving = useRovingFocus(navRef, { selector: ".navsection-h, .navmain", vertical: true });
  const onNavKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const t = e.target as HTMLElement;
    if (!e.altKey && !e.metaKey && !e.ctrlKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      const expand = e.key === "ArrowRight";
      if (t.classList.contains("navsection-h")) {
        e.preventDefault();
        if ((t.getAttribute("aria-expanded") === "true") !== expand) t.click();
        return;
      }
      const pin = expand && t.classList.contains("navmain") ? t.nextElementSibling : null;
      const main = !expand && t.classList.contains("navpin") ? t.previousElementSibling : null;
      const to = (pin ?? main) as HTMLElement | null;
      if (to) {
        e.preventDefault();
        to.focus();
        return;
      }
    }
    roving.onKeyDown(e);
  };

  const tools = PAGES.filter(
    (p) => TOOL_PAGES.includes(p.kind) && !hiddenPlaces.includes(p.kind) && (p.kind !== "skills" || hasAgents)
  );

  return (
    <nav
      ref={navRef}
      className="navpane"
      aria-label="Locations"
      onFocus={roving.onFocus}
      onKeyDown={onNavKeyDown}
    >
      <div ref={gliderRef} className="navglider" aria-hidden />
      <NavRow
        label="Home"
        icon={<HomeIcon />}
        selected={tab.location.kind === "home"}
        onClick={() => navigateTo({ kind: "home" })}
        title="Home"
        menu={() => placeMenu(() => navigateTo({ kind: "home" }))}
      />
      <NavRow
        label="User"
        icon={<PersonIcon />}
        selected={activePath === home}
        onClick={() => navigateTo({ kind: "path", path: home })}
        title={home}
        drop={`path:${home}`}
        menu={() => placeMenu(() => navigateTo({ kind: "path", path: home }))}
      />
      <NavRow
        label="Apps"
        icon={<AppsIcon />}
        selected={activePath === "/Applications"}
        onClick={() => navigateTo({ kind: "path", path: "/Applications" })}
        title="/Applications"
        drop="path:/Applications"
        menu={() => placeMenu(() => navigateTo({ kind: "path", path: "/Applications" }))}
      />
      {PAGES.filter((p) => !TOOL_PAGES.includes(p.kind) && !hiddenPlaces.includes(p.kind)).map((p) => (
        <NavRow
          key={p.kind}
          label={p.label}
          icon={p.icon}
          selected={tab.location.kind === p.kind}
          onClick={() => navigateTo({ kind: p.kind })}
          title={p.title}
          menu={() => placeMenu(() => navigateTo({ kind: p.kind }), p.kind)}
        />
      ))}
      <NavRow
        label="Trash"
        icon={
          <TrashIcon
            fraction={(trashBytes ?? 0) / TRASH_LIMIT_BYTES}
            colorId={trashColor}
          />
        }
        selected={activePath === `${home}/.Trash`}
        onClick={() => navigateTo({ kind: "path", path: `${home}/.Trash` })}
        title={
          trashBytes === null
            ? `${home}/.Trash`
            : `Trash · ${formatSize(trashBytes)}`
        }
        drop="trash"
        menu={() => [
          {
            key: "open",
            label: "Open",
            onSelect: () => navigateTo({ kind: "path", path: `${home}/.Trash` }),
          },
          { key: "empty", label: "Empty Trash", dividerBefore: true, onSelect: emptyTrash },
        ]}
      />
      <div className="navgap" />

      <NavSection
        title="Quick access"
        open={isOpen("quick")}
        onToggle={() => toggleSection("quick")}
        menu={() => [unhideQuickAccess()]}
      >
        {quickPins.map((pin) => {
          const name = baseName(pin);
          return folderRow({
            key: pin,
            label: name,
            path: pin,
            icon: QUICK_ICONS[name],
            menu: () => quickAccessMenu(name, () => navigateTo({ kind: "path", path: pin })),
          });
        })}
        {showScreenshots && (
          <NavRow
            label="Screenshots"
            icon={<ScreenshotIcon />}
            selected={tab.location.kind === "screenshots"}
            onClick={() => navigateTo({ kind: "screenshots" })}
            title="Files named Screenshot…, wherever they are"
            menu={() => quickAccessMenu("Screenshots", () => navigateTo({ kind: "screenshots" }))}
          />
        )}
        {quickPins.length === 0 && !showScreenshots && (
          <div className="navhint">Right-click “Quick access” to show its folders again.</div>
        )}
      </NavSection>

      <NavSection
        title="Favorites"
        open={isOpen("favorites")}
        onToggle={() => toggleSection("favorites")}
        drop="nav|favs"
      >
        {appdata.favorites.length === 0 ? (
          <div className="navhint">
            Right-click a folder and choose “Add to Favorites”.
          </div>
        ) : (
          appdata.favorites.map((fav) => {
            const open = () =>
              fav.isDir === false
                ? useTabs.getState().reveal(fav.path)
                : navigateTo({ kind: "path", path: fav.path });
            return (
              <NavRow
                key={fav.path}
                label={fav.name}
                icon={fav.isDir === false ? <DocumentIcon /> : <FolderIcon />}
                selected={fav.isDir !== false && activePath === fav.path}
                onClick={open}
                title={fav.path}
                drop={fav.isDir === false ? undefined : `path:${fav.path}`}
                menu={() => [
                  { key: "open", label: "Open", onSelect: open },
                  {
                    key: "remove",
                    label: "Remove from Favorites",
                    dividerBefore: true,
                    onSelect: () => appdata.toggleFavorite(fav),
                  },
                  {
                    key: "props",
                    label: "Properties",
                    dividerBefore: true,
                    onSelect: () =>
                      useUI.getState().openProperties(
                        fav.isDir === false
                          ? { ...folderEntry(fav.path), isDir: false, ext: fileExt(fav.name) }
                          : folderEntry(fav.path)
                      ),
                  },
                ]}
              />
            );
          })
        )}
      </NavSection>

      {savedSearches.length > 0 && (
        <NavSection title="Searches" open={isOpen("searches")} onToggle={() => toggleSection("searches")}>
          {savedSearches.map((s) => {
            const where = baseName(s.root) || "Computer";
            const open = () => runSavedSearch(s);
            return (
              <NavRow
                key={`${s.root}\0${s.query}\0${s.contents}`}
                label={`${s.query} in ${where}`}
                icon={<SearchIcon />}
                selected={false}
                onClick={open}
                title={`“${s.query}” in ${s.root}${s.contents ? ", names and contents" : ""}`}
                menu={() => [
                  { key: "open", label: "Open", onSelect: open },
                  { key: "remove", label: "Remove from sidebar", dividerBefore: true, onSelect: () => toggleSavedSearch(s) },
                ]}
              />
            );
          })}
        </NavSection>
      )}

      <NavSection
        title="Drives"
        open={isOpen("drives")}
        onToggle={() => toggleSection("drives")}
      >
        {localVolumes.map(volumeRow)}
      </NavSection>

      {networkVolumes.length > 0 && (
        <NavSection
          title="Network"
          open={isOpen("network")}
          onToggle={() => toggleSection("network")}
        >
          {networkVolumes.map(volumeRow)}
        </NavSection>
      )}

      {appdata.cloudDrives.length > 0 && (
        <NavSection
          title="Cloud Drive"
          open={isOpen("cloud")}
          onToggle={() => toggleSection("cloud")}
          menu={cloudHeadingMenu}
        >
          {cloudDrives.map((drive) => (
            <NavRow
              key={drive.path}
              label={drive.name}
              icon={<CloudIcon />}
              selected={activePath === drive.path}
              onClick={() => navigateTo({ kind: "path", path: drive.path })}
              title={drive.path}
              drop={`path:${drive.path}`}
              menu={() => cloudMenu(drive)}
            />
          ))}
          {cloudDrives.length === 0 && (
            <div className="navhint">
              {hiddenCloudCount === 1 ? "1 drive is hidden." : `${hiddenCloudCount} drives are hidden.`}{" "}
              Right-click “Cloud Drive” to show them again.
            </div>
          )}
        </NavSection>
      )}

      {tools.length > 0 && (
        <NavSection title="Tools" open={isOpen("tools")} onToggle={() => toggleSection("tools")}>
          {tools.map((p) => (
            <NavRow
              key={p.kind}
              label={p.label}
              icon={p.icon}
              selected={tab.location.kind === p.kind}
              onClick={() => navigateTo({ kind: p.kind })}
              title={p.title}
              menu={() => placeMenu(() => navigateTo({ kind: p.kind }), p.kind)}
            />
          ))}
        </NavSection>
      )}
    </nav>
  );
}
