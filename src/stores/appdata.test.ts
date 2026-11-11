import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  loadStore: vi.fn(),
  saveStore: vi.fn(() => Promise.resolve()),
  setAsideStore: vi.fn(() => Promise.resolve()),
}));

vi.mock("../ipc", () => ({
  api: new Proxy(api, { get: (t, k: string) => t[k as keyof typeof t] ?? (() => Promise.resolve(null)) }),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("a store that can't be loaded", () => {
  it("is never saved over when it can't be read", async () => {
    api.loadStore.mockRejectedValue("Operation not permitted");
    const { useAppData, flushAppData } = await import("./appdata");
    await useAppData.getState().init();
    useAppData.getState().addRecentFolder("/Users/me/Documents");
    await flushAppData();
    expect(api.saveStore).not.toHaveBeenCalled();
  });

  it("is kept aside before saves go on when it can't be understood", async () => {
    api.loadStore.mockResolvedValue("{not json");
    const { useAppData, flushAppData } = await import("./appdata");
    await useAppData.getState().init();
    expect(api.setAsideStore).toHaveBeenCalled();
    await flushAppData();
    expect(api.saveStore).toHaveBeenCalled();
  });
});

describe("edits made while the saved data loads", () => {
  const recent = (path: string) => ({ path, name: path.slice(1), dirName: "/", ts: 1 });
  const stored = (over = {}) =>
    JSON.stringify({ favorites: [], recents: [], recentFolders: [recent("/old")], trashOrigins: {}, history: [], activity: [], ...over });
  const folders = (s: { recentFolders: { path: string }[] }) => s.recentFolders.map((r) => r.path);

  it("run on the saved data instead of replacing it, and are saved", async () => {
    api.loadStore.mockResolvedValue(stored());
    const { useAppData, flushAppData } = await import("./appdata");
    const load = useAppData.getState().init();
    useAppData.getState().addRecentFolder("/new");
    await load;
    expect(folders(useAppData.getState())).toEqual(["/new", "/old"]);
    await flushAppData();
    expect(folders(JSON.parse((api.saveStore.mock.lastCall as unknown as [string])[0]))).toEqual(["/new", "/old"]);
  });

  it("write nothing before the load ends", async () => {
    let finish!: (raw: string) => void;
    api.loadStore.mockReturnValue(new Promise((r) => (finish = r)));
    vi.useFakeTimers();
    try {
      const { useAppData, flushAppData } = await import("./appdata");
      const load = useAppData.getState().init();
      useAppData.getState().addRecentFolder("/new");
      await flushAppData();
      await vi.advanceTimersByTimeAsync(1000);
      expect(api.saveStore).not.toHaveBeenCalled();
      finish(stored());
      await vi.runAllTimersAsync();
      await load;
    } finally {
      vi.useRealTimers();
    }
  });

  it("still lets a newer list from another window win over the disk copy", async () => {
    api.loadStore.mockResolvedValue(stored());
    const { useAppData } = await import("./appdata");
    const load = useAppData.getState().init();
    useAppData.setState({ recentFolders: [recent("/mirrored")] });
    useAppData.getState().addRecentFolder("/new");
    await load;
    expect(folders(useAppData.getState())).toEqual(["/new", "/mirrored"]);
  });

  it("keep what a star click meant on the list that was showing", async () => {
    const fav = { path: "/fav", name: "fav", dirName: "/", modifiedMs: 1, isDir: true };
    api.loadStore.mockResolvedValue(stored({ favorites: [fav] }));
    const { useAppData } = await import("./appdata");
    const load = useAppData.getState().init();
    useAppData.getState().toggleFavorite(fav);
    await load;
    expect(useAppData.getState().favorites.map((f) => f.path)).toEqual(["/fav"]);
    useAppData.getState().toggleFavorite(fav);
    expect(useAppData.getState().favorites).toEqual([]);
  });

  it("are kept out of a store that can't be read", async () => {
    api.loadStore.mockRejectedValue("Operation not permitted");
    const { useAppData, flushAppData } = await import("./appdata");
    const load = useAppData.getState().init();
    useAppData.getState().addRecentFolder("/new");
    await load;
    expect(useAppData.getState().phase).toBe("readOnly");
    await flushAppData();
    expect(api.saveStore).not.toHaveBeenCalled();
  });
});

describe("trash origins", () => {
  it("load from older stores and drop malformed entries", async () => {
    api.loadStore.mockResolvedValue(
      JSON.stringify({
        trashOrigins: { "/t/a": "/x/a", "/t/b": { origin: "/x/b", id: "1:2" }, "/t/c": 5, "/t/d": { origin: "rel" } },
      })
    );
    const { useAppData } = await import("./appdata");
    await useAppData.getState().init();
    expect(useAppData.getState().trashOrigins).toEqual({
      "/t/a": { origin: "/x/a" },
      "/t/b": { origin: "/x/b", id: "1:2" },
    });
  });

  it("belong only to the item that was recorded", async () => {
    const { originOf } = await import("./appdata");
    const origins = { "/t/a": { origin: "/x/a", id: "1:2" }, "/t/old": { origin: "/x/old" } };
    expect(originOf("/t/a", "1:2", origins)).toBe("/x/a");
    expect(originOf("/t/a", "1:9", origins)).toBeNull();
    expect(originOf("/t/a", null, origins)).toBe("/x/a");
    expect(originOf("/t/old", "1:9", origins)).toBe("/x/old");
    expect(originOf("/t/none", "1:2", origins)).toBeNull();
  });
});

describe("inCloudDrive", () => {
  it("finds items inside a drive but not beside it", async () => {
    const { inCloudDrive } = await import("./appdata");
    const drive = { name: "Google Drive", path: "/Users/me/Library/CloudStorage/GoogleDrive-me" };
    expect(inCloudDrive(["/Users/me/Desktop/a", `${drive.path}/b`], [drive])).toEqual({ path: `${drive.path}/b`, drive });
    expect(inCloudDrive([drive.path], [drive])?.drive).toBe(drive);
    expect(inCloudDrive([`${drive.path}-old/b`], [drive])).toBeUndefined();
  });
});

describe("recent folders", () => {
  it("count visits, keep one entry per folder, and load a store saved without counts", async () => {
    api.loadStore.mockResolvedValue(
      JSON.stringify({ recentFolders: [{ path: "/old", name: "old", dirName: "/", ts: 1 }] })
    );
    const { useAppData } = await import("./appdata");
    await useAppData.getState().init();
    useAppData.getState().addRecentFolder("/old");
    useAppData.getState().addRecentFolder("/old");
    const list = useAppData.getState().recentFolders;
    expect(list.map((r) => [r.path, r.visits])).toEqual([["/old", 2]]);
  });
});
