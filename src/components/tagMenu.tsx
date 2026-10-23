import { TagRegular } from "@fluentui/react-icons";
import { clearTags, getViewEntries, setTag } from "../actions";
import { currentTags } from "../stores/tags";
import { useSettings } from "../stores/settings";
import { useUI, type MenuItemSpec } from "../stores/ui";
import { TagDot } from "./TagDots";
import { COLOR_TAGS, TAG_COLORS, compareTags, isColorTag, tagKey, tagState, tagsIn } from "../util/tags";
import type { FileEntry, Tag } from "../types";

/** The colour dots and the Tags submenu for `entries` in a context menu. */
export function tagMenuItems(entries: FileEntry[]): MenuItemSpec[] {
  const items = entries.map((e) => ({ ...e, tags: currentTags(e) }));
  const swatches = COLOR_TAGS.map((t) => {
    const state = tagState(items, t.name);
    return {
      key: t.name,
      label: t.name,
      color: TAG_COLORS[t.color],
      state,
      onSelect: () => setTag(entries, t, state !== "on"),
    };
  });
  // Tags made here, plus any already in use around these items.
  const others = new Map<string, Tag>();
  const offer = (t: Tag) => {
    if (!isColorTag(t) && !others.has(tagKey(t.name))) others.set(tagKey(t.name), t);
  };
  useSettings.getState().customTags.forEach(offer);
  tagsIn(items).forEach(({ tag }) => offer(tag));
  tagsIn(getViewEntries()).forEach(({ tag }) => offer(tag));
  const custom = [...others.values()].sort(compareTags);
  const tagged = items.some((e) => e.tags.length > 0);
  return [
    { key: "tag-colors", label: "Tags", swatches, dividerBefore: true },
    {
      key: "tags",
      label: "Tags",
      icon: <TagRegular />,
      items: [
        ...custom.map((t) => {
          const state = tagState(items, t.name);
          return {
            key: `tag:${t.name}`,
            label: t.name,
            icon: <TagDot color={t.color} />,
            checked: state === "on",
            onSelect: () => setTag(entries, t, state !== "on"),
          };
        }),
        {
          key: "new-tag",
          label: "New Tag…",
          dividerBefore: custom.length > 0,
          onSelect: () => useUI.getState().openNewTag(entries),
        },
        ...(tagged
          ? [{ key: "clear-tags", label: "Remove All Tags", onSelect: () => void clearTags(entries) }]
          : []),
      ],
    },
  ];
}
