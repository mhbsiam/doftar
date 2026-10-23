import { useDeferredValue, useEffect, useMemo } from "react";
import { useActiveTab, usePaneStore, useTabs } from "../stores/tabs";
import { useSettings } from "../stores/settings";
import { useTags, useTagScan, withTags } from "../stores/tags";
import { useDirectory } from "../hooks/useDirectory";
import { useSearch } from "../hooks/useSearch";
import { useTagSearch } from "../hooks/useTagSearch";
import { useFolderView } from "../hooks/useFolderView";
import { FolderView } from "./FolderView";
import { HomeView } from "./HomeView";
import { DiskView } from "./DiskView";
import { TagsView } from "./TagsView";
import { isFolder } from "../util/kinds";
import { hasTag, matchesTagFilter, tagFilterActive, tagsIn } from "../util/tags";
import { notifySettled } from "../util/transition";

const NO_NAMES: string[] = [];

export function ContentArea() {
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
  const tagPage = tab.location.kind === "tags" ? (tab.location.tag ?? null) : null;
  useEffect(() => {
    if (here === null || loadedPath === here) notifySettled();
  });

  const tagFilter = here !== null && tagFilterActive(tab.tagFilter) ? tab.tagFilter : null;
  const deepTags = tagFilter?.deep === true;
  // All items with one tag (a tag page), or a folder's subfolders searched
  // for tagged items.
  const tagRoot = deepTags ? here : null;
  const tagNames = tagPage !== null ? [tagPage] : tagFilter && !tagFilter.any ? tagFilter.names : NO_NAMES;
  const tagFound = useTagSearch(
    tagRoot,
    tagNames,
    showHidden,
    tagPage !== null || deepTags,
    refreshTick
  );

  // The box updates at once; the (possibly huge) filtered list catches up at
  // low priority, so typing never waits on re-filtering and re-sorting it.
  const typed = search.trim().toLowerCase();
  const q = useDeferredValue(typed);
  const deep = here !== null && deepSearch === here && typed !== "" && !deepTags;
  const found = useSearch(here, search, showHidden, deep);

  // Listings read tags only for items with a colour label; fill in the rest.
  const listingSettled = here !== null && loadedPath === here && !loading;
  useTagScan(entries, listingSettled, tagFilter !== null || groupBy === "tags", refreshTick);
  const tagRev = useTags((s) => s.rev);
  const listed = useMemo(
    () => withTags(entries, useTags.getState().byPath),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, tagRev]
  );
  const tagResults = useMemo(() => {
    const merged = withTags(tagFound.entries, useTags.getState().byPath);
    // Results Spotlight hasn't caught up on yet (a tag just removed) drop out.
    return tagPage !== null
      ? merged.filter((e) => hasTag(e, tagPage))
      : tagFilter
        ? merged.filter((e) => matchesTagFilter(e, tagFilter))
        : merged;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagFound.entries, tagRev, tagPage, tagFilter]);

  // The Filter menu offers the tags found in this folder.
  const paneTabs = usePaneStore();
  useEffect(() => {
    paneTabs.getState().setFolderTags(here !== null ? tagsIn(listed) : []);
  }, [here, listed, paneTabs]);

  const resultsPage = tagPage !== null || deepTags;
  const source = resultsPage ? tagResults : listed;
  // Lowercased once per listing, not once per keystroke.
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
  // Stable between renders, so the list below doesn't re-sort when only
  // the urgent part of a keystroke has rendered.
  const filtered = useMemo(
    () =>
      filter === "folders"
        ? tagged.filter((e) => isFolder(e))
        : filter === "files"
          ? tagged.filter((e) => !isFolder(e))
          : tagged,
    [tagged, filter]
  );

  // Once a listing has settled, a selection may still name items that were
  // renamed or removed behind our back (Finder, another tab). Drop those so
  // copy/open/delete don't act on dead paths and counts stay honest.
  // A folder still streaming in has only part of its rows, so don't prune yet.
  const settled = resultsPage
    ? !tagFound.searching
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
  if (tab.location.kind === "tags" && tagPage === null) {
    return <TagsView />;
  }
  return (
    <FolderView
      entries={filtered}
      sortSource={deep || resultsPage ? undefined : listed}
      totalCount={searched.length}
      error={resultsPage ? tagFound.error : deep ? found.error : error}
      loading={resultsPage ? tagFound.searching : deep ? found.searching : loading}
      searchRoot={tagPage !== null ? "/" : deep || deepTags ? here : null}
      searchTruncated={resultsPage ? tagFound.truncated : deep && found.truncated}
    />
  );
}
