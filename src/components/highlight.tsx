import type { ReactNode } from "react";
import { common, createLowlight } from "lowlight";
import type { ElementContent, RootContent } from "hast";

const lowlight = createLowlight(common);

/** Longer code is shown uncoloured; colouring it would hold up the page. */
const MAX_HIGHLIGHT = 512 * 1024;

function toReact(nodes: (RootContent | ElementContent)[]): ReactNode[] {
  return nodes.map((n, i) => {
    if (n.type === "text") return n.value;
    if (n.type !== "element") return null;
    const cls = n.properties.className;
    return (
      <span key={i} className={Array.isArray(cls) ? cls.join(" ") : undefined}>
        {toReact(n.children)}
      </span>
    );
  });
}

/**
 * `code` coloured as `lang`, as spans with highlight.js classes; plain text
 * for a language it doesn't know or code too long to colour quickly.
 */
export function highlight(lang: string, code: string): ReactNode {
  const name = lang.toLowerCase();
  if (!name || code.length > MAX_HIGHLIGHT || !lowlight.registered(name)) return code;
  try {
    return toReact(lowlight.highlight(name, code).children);
  } catch {
    return code;
  }
}
