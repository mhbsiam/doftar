/** One row of a commit graph: the lane of the commit and the lines through the row. */
export interface GraphRow {
  lane: number;
  /** Lines from the top edge (lane `from`) to the bottom edge (lane `to`) that pass by. */
  through: { from: number; to: number }[];
  /** Lanes that arrive at the commit from above. */
  into: number[];
  /** Lanes that leave the commit downward, to its parents. */
  out: number[];
  width: number;
}

/**
 * Lays out commits in lanes, like `git log --graph`. Input: newest first, children before parents.
 * Each lane waits for the next commit it leads to.
 */
export function layoutGraph(commits: { id: string; parents: string[] }[]): GraphRow[] {
  let lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  for (const c of commits) {
    let lane = lanes.indexOf(c.id);
    if (lane < 0) {
      lane = lanes.indexOf(null);
      if (lane < 0) lane = lanes.push(null) - 1;
    }
    const into = lanes.flatMap((id, i) => (id === c.id ? [i] : []));
    const next = lanes.map((id) => (id === c.id ? null : id));
    const out: number[] = [];
    c.parents.forEach((p, k) => {
      let at = next.indexOf(p);
      if (at < 0) {
        // The first parent continues the lane of the commit.
        at = k === 0 && next[lane] === null ? lane : next.indexOf(null);
        if (at < 0) at = next.push(null) - 1;
        next[at] = p;
      }
      out.push(at);
    });
    const through = lanes.flatMap((id, i) =>
      id !== null && id !== c.id ? [{ from: i, to: next.indexOf(id) }] : []
    );
    while (next.length > 0 && next[next.length - 1] === null) next.pop();
    rows.push({
      lane,
      through,
      into,
      out,
      width: Math.max(lanes.length, next.length, lane + 1),
    });
    lanes = next;
  }
  return rows;
}
