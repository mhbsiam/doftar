/** One row of a side-by-side comparison. A changed line pairs a removal with an addition. */
export interface DiffRow {
  kind: "same" | "change";
  /** Line number and text on the left. Null for a line only the right side has. */
  left: { n: number; text: string } | null;
  right: { n: number; text: string } | null;
}

type Op = "same" | "del" | "add";

/** The trace back holds about 4 bytes × edits², so this is about 64 MB. */
const MAX_EDITS = 4000;

/** The shortest edit script from `a` to `b`, or null if it needs more than `MAX_EDITS` edits. */
function editScript(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  // v[k] = furthest x on diagonal k after d steps. Keep the diagonals step d can read, for the trace back.
  const trace: Int32Array[] = [];
  const v = new Int32Array(2 * max + 3);
  let found = false;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]);
      let x = down ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break outer;
      }
    }
  }
  if (!found) return null;
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const at = (diagonal: number) => vd[diagonal + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("same");
      x--;
      y--;
    }
    if (d > 0) {
      ops.push(down ? "add" : "del");
      if (down) y--;
      else x--;
    }
  }
  return ops.reverse();
}

/** `exact` is false when the files differ too much to align, so everything between their shared ends is one change. */
export function diffLines(a: string[], b: string[]): { rows: DiffRow[]; exact: boolean } {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const middleA = a.slice(head, a.length - tail);
  const middleB = b.slice(head, b.length - tail);
  const script = editScript(middleA, middleB);
  const middle = script ?? [...middleA.map((): Op => "del"), ...middleB.map((): Op => "add")];
  const same = (count: number) => new Array<Op>(count).fill("same");
  const ops = [...same(head), ...middle, ...same(tail)];
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  for (let p = 0; p < ops.length; ) {
    if (ops[p] === "same") {
      rows.push({ kind: "same", left: { n: i + 1, text: a[i] }, right: { n: j + 1, text: b[j] } });
      i++;
      j++;
      p++;
      continue;
    }
    let dels = 0;
    let adds = 0;
    for (; p < ops.length && ops[p] === "del"; p++) dels++;
    for (; p < ops.length && ops[p] === "add"; p++) adds++;
    for (let r = 0; r < Math.max(dels, adds); r++) {
      rows.push({
        kind: "change",
        left: r < dels ? { n: i + r + 1, text: a[i + r] } : null,
        right: r < adds ? { n: j + r + 1, text: b[j + r] } : null,
      });
    }
    i += dels;
    j += adds;
  }
  return { rows, exact: script !== null };
}

/** Lines of `text`. A final newline does not make an empty last line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
