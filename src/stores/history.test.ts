import { beforeEach, describe, expect, it, vi } from "vitest";
import { placeName, staleSteps, stepEnds, summarize, undoQuestion, useHistory } from "./history";
import { api } from "../ipc";
import type { Step } from "../types";

vi.mock("../ipc", () => ({ api: { discardAsides: vi.fn(() => Promise.resolve()) } }));

const trash = (path: string): Step => ({ kind: "trash", path });
const back = (path: string): Step => ({ kind: "move", from: `/T/${path}`, to: path });
const move = (from: string, to: string, id?: string): Step => ({ kind: "move", from, to, id });
const HOME = "/Users/me";
// Add a folder id after each destination id.
const withFolders = (pairs: (string | null)[]) =>
  pairs.flatMap((id, i) => (i % 2 ? [id, "dir"] : [id]));

beforeEach(() => {
  useHistory.setState({ undo: [], redo: [], log: [] });
  vi.mocked(api.discardAsides).mockClear();
});

describe("asides", () => {
  const aside = "/share/.a.txt.doftar-aside-1-0";
  it("are discarded once no entry can restore them: a redo cleared, an entry pushed off, the log cleared", () => {
    const entry = useHistory.getState().record("Move", [move("/share/a.txt", "/local/a.txt"), move(aside, "/share/a.txt")]);
    useHistory.getState().settle("undo", entry, [move("/local/a.txt", "/share/a.txt"), move("/share/a.txt", aside)]);
    expect(api.discardAsides).not.toHaveBeenCalled();
    useHistory.getState().record("Rename", [move("/b", "/a")]);
    expect(api.discardAsides).toHaveBeenCalledWith(["/local/a.txt", "/share/a.txt"]);
    for (let i = 0; i < 50; i++) useHistory.getState().record("Copy", [trash(`/c${i}`)]);
    expect(api.discardAsides).toHaveBeenLastCalledWith(["/b"]);
    useHistory.getState().clearLog();
    expect(api.discardAsides).toHaveBeenLastCalledWith(Array.from({ length: 50 }, (_, i) => `/c${i}`));
  });
});

describe("settle", () => {
  it("moves a finished undo to the redo stack", () => {
    const entry = useHistory.getState().record("Copy", [trash("/a")]);
    useHistory.getState().settle("undo", entry, [back("/a")]);
    expect(useHistory.getState().undo).toEqual([]);
    expect(useHistory.getState().redo).toEqual([{ ...entry, steps: [back("/a")] }]);
  });

  it("keeps the steps a cancelled undo never got to", () => {
    const older = useHistory.getState().record("Rename", [trash("/x")]);
    const entry = useHistory.getState().record("Copy", [trash("/a"), trash("/b")]);
    useHistory.getState().settle("undo", entry, [back("/a")], [trash("/b")]);
    const { undo, redo } = useHistory.getState();
    expect(undo).toEqual([older, { ...entry, steps: [trash("/b")] }]);
    expect(redo).toEqual([{ ...entry, steps: [back("/a")] }]);
  });

  it("undoes an entry below the newest, leaving the newer one in place", () => {
    const older = useHistory.getState().record("Move", [move("/d/a", "/s/a")]);
    const newer = useHistory.getState().record("Rename", [move("/x/b", "/x/c")]);
    useHistory.getState().settle("undo", older, [move("/s/a", "/d/a")]);
    expect(useHistory.getState().undo).toEqual([newer]);
    expect(useHistory.getState().redo.map((e) => e.id)).toEqual([older.id]);
  });

  it("finds the entry after another window's change replaced every entry with a copy", () => {
    const entry = useHistory.getState().record("Move", [move("/d/a", "/s/a")]);
    // Window sync delivers equal entries in new objects.
    const { undo, log } = useHistory.getState();
    useHistory.setState(structuredClone({ undo, log }));
    useHistory.getState().settle("undo", entry, [move("/s/a", "/d/a")]);
    expect(useHistory.getState().undo).toEqual([]);
    expect(useHistory.getState().redo.map((e) => e.id)).toEqual([entry.id]);
  });
});

describe("activity log", () => {
  it("keeps every action, undone or not, with the id undo and redo carry", () => {
    const entry = useHistory.getState().record("Copy", [trash("/d/a")], ["/s/a"]);
    useHistory.getState().settle("undo", entry, [back("/d/a")]);
    const redone = useHistory.getState().redo[0];
    useHistory.getState().settle("redo", redone, [trash("/d/a")]);
    const { log, undo } = useHistory.getState();
    expect(log).toEqual([{ ...entry, undone: false }]);
    expect(undo[0].id).toBe(entry.id);
  });

  it("keeps one entry per id when a redo meets what a cancelled undo left", () => {
    const entry = useHistory.getState().record("Move", [move("/d/a", "/s/a"), move("/d/b", "/s/b")]);
    useHistory.getState().settle("undo", entry, [move("/s/a", "/d/a")], [move("/d/b", "/s/b")]);
    useHistory.getState().settle("redo", useHistory.getState().redo[0], [move("/d/a", "/s/a")]);
    const { undo, redo } = useHistory.getState();
    expect(redo).toEqual([]);
    expect(undo).toHaveLength(1);
    expect(undo[0]).toMatchObject({ id: entry.id, steps: [move("/d/a", "/s/a"), move("/d/b", "/s/b")] });
  });

  it("clears undo and redo with the log", () => {
    useHistory.getState().record("New Folder", [trash("/x/f")]);
    useHistory.getState().clearLog();
    expect(useHistory.getState()).toMatchObject({ log: [], undo: [], redo: [] });
  });

  it("marks an undone entry, even after a new action clears redo", () => {
    const entry = useHistory.getState().record("Rename", [move("/x/b", "/x/a")]);
    useHistory.getState().settle("undo", entry, [move("/x/a", "/x/b")]);
    useHistory.getState().record("New Folder", [trash("/x/f")]);
    expect(useHistory.getState().redo).toEqual([]);
    expect(useHistory.getState().log[0].undone).toBe(true);
  });

  it("logs a permanent delete with nothing to undo it", () => {
    useHistory.getState().logOnly("Delete Immediately", ["/d/a"]);
    const { log, undo } = useHistory.getState();
    expect(log).toHaveLength(1);
    expect(log[0].steps).toEqual([]);
    expect(undo).toEqual([]);
  });

  it("shows restored entries, which get fresh ids", () => {
    useHistory.getState().restore([{ label: "Rename", steps: [move("/x/b", "/x/a")], at: 5 }]);
    const { log, undo } = useHistory.getState();
    expect(log).toEqual(undo);
    expect(undo[0]).toMatchObject({ label: "Rename", at: 5 });
    expect(typeof undo[0].id).toBe("number");
  });

  it("restores logged-only actions among the undoable ones, in time order", () => {
    useHistory.getState().restore(
      [{ label: "Rename", steps: [move("/x/b", "/x/a")], at: 5 }],
      [{ label: "Empty Trash", steps: [], at: 3 }]
    );
    expect(useHistory.getState().log.map((e) => e.label)).toEqual(["Empty Trash", "Rename"]);
  });
});

describe("summarize", () => {
  const entry = (label: string, steps: Step[], sources?: string[]) =>
    ({ id: 1, at: 0, label, steps, sources });

  it("reads a move's source and destination from its undo", () => {
    expect(summarize(entry("Move", [move("/d/a", "/s/a"), move("/d/b", "/s/b")]))).toEqual({
      items: ["/s/a", "/s/b"],
      from: "/s",
      to: "/d",
    });
  });

  it("names a rename's old and new name", () => {
    expect(summarize(entry("Rename", [move("/x/new", "/x/old")]))).toEqual({
      items: ["/x/old"],
      to: "/x",
      renamed: "new",
    });
  });

  it("takes a copy's originals from its sources, past a replaced item's restore", () => {
    const s = summarize(entry("Copy", [move(`${HOME}/.Trash/a`, "/d/a"), trash("/d/a")], ["/s/a"]));
    expect(s).toEqual({ items: ["/s/a"], from: "/s", to: "/d" });
  });

  it("counts a replace once in entries saved without sources", () => {
    const copied = summarize(entry("Copy", [trash("/d/a"), move(`${HOME}/.Trash/a`, "/d/a")]));
    expect(copied.items).toEqual(["/d/a"]);
    const moved = summarize(entry("Move", [move("/d/a", "/s/a"), move(`${HOME}/.Trash/a`, "/d/a")]));
    expect(moved).toEqual({ items: ["/s/a"], from: "/s", to: "/d" });
  });

  it("reads the steps when sources is empty", () => {
    expect(summarize(entry("Copy", [trash("/d/a")], [])).items).toEqual(["/d/a"]);
  });

  it("says where trashed items went", () => {
    const s = summarize(entry("Move to Trash", [move(`${HOME}/.Trash/a`, `${HOME}/Documents/a`)]));
    expect(placeName(s.to!, HOME)).toBe("the Trash");
    expect(placeName(s.from!, HOME)).toBe("~/Documents");
  });
});

describe("staleSteps", () => {
  it("finds steps whose item is gone, replaced, or blocked by a newcomer", () => {
    const steps = [
      move("/d/a", "/s/a", "1"),
      move("/d/b", "/s/b", "2"),
      move("/d/c", "/s/c"),
      trash("/d/e"),
      move("/x/A", "/x/a", "5"),
      move("/d/f", "/s/f", "6"),
    ];
    expect(stepEnds(steps)).toHaveLength(18);
    const ids = withFolders([null, null, "9", null, "3", "7", null, null, "5", "5", "6", null]);
    // The first four steps are stale. The case-only rename and the last step still run.
    expect(staleSteps(steps, ids)).toEqual([steps[0], steps[1], steps[2], steps[3]]);
  });

  it("lets a replaced item come back once the step before moves the newcomer away", () => {
    const copied = [trash("/d/a"), move(`${HOME}/.Trash/a`, "/d/a", "old")];
    expect(staleSteps(copied, withFolders(["new", "new", "old", "new"]))).toEqual([]);
    const moved = [move("/d/a", "/s/a", "new"), move(`${HOME}/.Trash/a`, "/d/a", "old")];
    expect(staleSteps(moved, withFolders(["new", null, "old", "new"]))).toEqual([]);
    // Fails if the step that frees the path cannot run.
    expect(staleSteps(copied, withFolders([null, null, "old", "new"]))).toEqual(copied);
  });

  it("can't put an item back in a folder that's gone, unless an earlier step brings the folder back", () => {
    const steps = [move("/T/f", "/d/f", "f"), move("/T/a", "/d/f/a", "a"), move("/T/b", "/gone/b", "b")];
    const ids = ["f", null, "dir", "a", null, null, "b", null, null];
    expect(staleSteps(steps, ids)).toEqual([steps[2]]);
  });
});

describe("undoQuestion", () => {
  it("says where a move goes back to", () => {
    const steps = [1, 2, 3].map((i) => move(`/d/${i}`, `${HOME}/Documents/${i}`));
    expect(undoQuestion(steps, [], HOME)).toBe("Move 3 items back to ~/Documents?");
  });

  it("names a rename, and a copy's removal", () => {
    expect(undoQuestion([move("/x/new", "/x/old")], [], HOME)).toBe('Rename "new" back to "old"?');
    expect(undoQuestion([trash("/d/a")], [], HOME)).toBe('Move "a" to the Trash?');
  });

  it("puts trashed items back, and mentions what has changed since", () => {
    const steps = [move(`${HOME}/.Trash/a`, "/d/a"), move(`${HOME}/.Trash/b`, "/d/b")];
    expect(undoQuestion(steps, [steps[1]], HOME)).toBe(
      'Put "a" back in /d? "b" has changed or moved since and stays as it is.'
    );
  });

  it("joins a replace's two halves", () => {
    const steps = [trash("/d/a"), move(`${HOME}/.Trash/a`, "/d/a")];
    expect(undoQuestion(steps, [], HOME)).toBe('Move "a" to the Trash and put "a" back in /d?');
  });
});
