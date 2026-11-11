import { useDeferredValue, useEffect, useMemo, useRef } from "react";
import { useActiveTab, usePaneStore, useTabs } from "../stores/tabs";
import { useSettings } from "../stores/settings";
import { useAppData } from "../stores/appdata";
import { useTags, useTagScan, withTags } from "../stores/tags";
import { useDirectory } from "../hooks/useDirectory";
import { useSearch } from "../hooks/useSearch";
import { useTagSearch } from "../hooks/useTagSearch";
import { useGitWatch } from "../stores/git";
import { useFolderView } from "../hooks/useFolderView";
import { FolderView } from "./FolderView";
import { PaneBoundary } from "./PaneBoundary";
import { HomeView } from "./HomeView";
import { DiskView } from "./DiskView";
import { TagsView } from "./TagsView";
import { SkillsView } from "./SkillsView";
import { ReposView } from "./ReposView";
import { CompareView } from "./CompareView";
import { fileKind, isFolder } from "../util/kinds";
import { hasTag, matchesTagFilter, tagFilterActive, tagsIn } from "../util/tags";
import { itemFilterActive, matchesItemFilter } from "../util/itemFilter";
import { notifySettled } from "../util/transition";

const NO_NAMES: string[] = [];

/** The tab's page, inside a boundary that clears when the tab or its place changes. */
export function ContentArea() {
  const tab = useActiveTab();
  return (
    <PaneBoundary what="this tab" resetKey={`${tab.id}:${JSON.stringify(tab.location)}`}>
      <ContentBody />
    </PaneBoundary>
  );
}

function ContentBody() {
  const tab = useActiveTab();
  const refreshTick = useTabs((s) => s.refreshTick);
  const search = useTabs((s) => s.search);
  const deepSearch = useTabs((s) => s.deepSearch);
  const showHidden = useSettings((s) => s.showHidden);
  const filter = useSettings((s) => s.filter);
  const groupBy = useFolderView().groupBy;
  const { entries, error, loading, loadedPath } = useDirectory(
    tab.location,
    showHidden,
    refreshTick
  );

  const here = tab.location.kind === "path" ? tab.location.path : null;
  useGitWatch(here, entries, refreshTick);
  const tagPage = tab.location.kind === "tags" ? (tab.location.tag ?? null) : null;
  useEffect(() => {
    if (here === null || loadedPath === here) notifySettled();
  });

  const tagFilter = here !== null && tagFilterActive(tab.tagFilter) ? tab.tagFilter : null;
  const deepTags = tagFilter?.deep === true;
  const itemFilter = here !== null && itemFilterActive(tab.itemFilter) ? tab.itemFilter : null;
  const tagRoot = deepTags ? here : null;
  const tagNames = tagPage !== null ? [tagPage] : tagFilter && !tagFilter.any ? tagFilter.names : NO_NAMES;
  const tagFound = useTagSearch(
    tagRoot,
    tagNames,
    showHidden,
    tagPage !== null || deepTags,
    refreshTick
  );

  // The box updates at once. The huge filtered list updates at low priority.
  const typed = search.trim().toLowerCase();
  const q = useDeferredValue(typed);
  const deep = here !== null && deepSearch === here && typed !== "" && !deepTags;
  const searchContents = useSettings((s) => s.searchContents);
  const found = useSearch(here, search, showHidden, deep, 0, itemFilter, searchContents);
  // Screenshots: search home for "Screenshot", keep only images whose names start with it.
  // Until home is known, home is "/". That would search the whole disk.
  const home = useAppData((s) => (s.phase === "loading" ? null : s.home));
  const shotsPage = tab.location.kind === "screenshots";
  const shotsFound = useSearch(home, "Screenshot", showHidden, shotsPage, refreshTick);
  const shots = useMemo(
    () =>
      shotsFound.entries.filter(
        (e) =>
          !isFolder(e) &&
          fileKind(e.ext) === "image" &&
          e.name.toLowerCase().startsWith("screenshot") &&
          !e.path.startsWith(`${home}/Library/`)
      ),
    [shotsFound.entries, home]
  );
  const results = shotsPage ? shotsFound : tagFound;

  // Listings read tags only for items with a colour label. Read the rest here.
  const listingSettled = here !== null && loadedPath === here && !loading;
  useTagScan(entries, listingSettled, tagFilter !== null || groupBy === "tags", refreshTick);

  // Count a folder as visited once it lists. Refreshes do not count.
  const recorded = useRef<string | null>(null);
  useEffect(() => {
    if (here === null) recorded.current = null;
    else if (listingSettled && !error && recorded.current !== here) {
      recorded.current = here;
      useAppData.getState().addRecentFolder(here);
    }
  }, [here, listingSettled, error]);
  const tagRev = useTags((s) => s.rev);
  const listed = useMemo(
    () => withTags(entries, useTags.getState().byPath),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, tagRev]
  );
  const tagResults = useMemo(() => {
    const merged = withTags(tagFound.entries, useTags.getState().byPath);
    // Drop results that Spotlight has not updated yet after a tag removal.
    return tagPage !== null
      ? merged.filter((e) => hasTag(e, tagPage))
      : tagFilter
        ? merged.filter((e) => matchesTagFilter(e, tagFilter))
        : merged;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagFound.entries, tagRev, tagPage, tagFilter]);

  const paneTabs = usePaneStore();
  useEffect(() => {
    paneTabs.getState().setFolderTags(here !== null ? tagsIn(listed) : []);
  }, [here, listed, paneTabs]);

  const resultsPage = tagPage !== null || deepTags || shotsPage;
  const source = shotsPage ? shots : resultsPage ? tagResults : listed;
  // Lowercase once per listing, not once per keystroke.
  const lowered = useMemo(() => source.map((e) => e.name.toLowerCase()), [source]);
  const matched = useMemo(
    () => (q ? source.filter((_, i) => lowered[i].includes(q)) : source),
    [source, lowered, q]
  );
  const searched = deep ? withTags(found.entries, useTags.getState().byPath) : matched;
  const tagged = useMemo(
    () => (tagFilter && !deepTags ? searched.filter((e) => matchesTagFilter(e, tagFilter)) : searched),
    [searched, tagFilter, deepTags]
  );
  // Keep stable between renders. Then the list below does not re-sort.
  // A deep search already applied this filter before its cap. It is applied again here for the listing.
  const narrowed = useMemo(() => {
    if (!itemFilter) return tagged;
    const now = new Date();
    return tagged.filter((e) => matchesItemFilter(e, itemFilter, now));
  }, [tagged, itemFilter]);
  const filtered = useMemo(
    () =>
      filter === "folders"
        ? narrowed.filter((e) => isFolder(e))
        : filter === "files"
          ? narrowed.filter((e) => !isFolder(e))
          : narrowed,
    [narrowed, filter]
  );

  // Drop selected paths that were renamed or removed elsewhere, so commands do not act on dead paths.
  // Skip while a folder still streams in. It has only some rows.
  const settled = resultsPage
    ? !results.searching
    : here !== null && (deep ? !found.searching : listingSettled);
  const pruneSelection = useTabs((s) => s.pruneSelection);
  useEffect(() => {
    if (!settled) return;
    pruneSelection(new Set(searched.map((e) => e.path)));
  }, [settled, searched, pruneSelection]);

  if (tab.location.kind === "home") {
    return <HomeView />;
  }
  if (tab.location.kind === "disk") {
    return <DiskView />;
  }
  if (tab.location.kind === "skills") {
    return <SkillsView />;
  }
  if (tab.location.kind === "repos") {
    return <ReposView />;
  }
  if (tab.location.kind === "compare") {
    return <CompareView />;
  }
  if (tab.location.kind === "tags" && tagPage === null) {
    return <TagsView />;
  }
  return (
    <FolderView
      entries={filtered}
      sortSource={deep || resultsPage ? undefined : listed}
      totalCount={searched.length}
      error={resultsPage ? results.error : deep ? found.error : error}
      loading={resultsPage ? results.searching : deep ? found.searching : loading}
      searchRoot={tagPage !== null || shotsPage ? "/" : deep || deepTags ? here : null}
      searchTruncated={resultsPage ? results.truncated : deep && found.truncated}
    />
  );
}
