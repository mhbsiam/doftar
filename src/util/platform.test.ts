import { describe, expect, it } from "vitest";
import { linuxKeys } from "./platform";

describe("linuxKeys", () => {
  it("writes macOS key labels the Linux way", () => {
    expect(linuxKeys("⌘D")).toBe("Ctrl+D");
    expect(linuxKeys("⇧⌘Z")).toBe("Ctrl+Shift+Z");
    expect(linuxKeys("⌘⌥V")).toBe("Ctrl+Alt+V");
    expect(linuxKeys("⌥⌘T")).toBe("Ctrl+Alt+T");
    expect(linuxKeys("⌘⌫ or Delete")).toBe("Ctrl+Backspace or Delete");
    expect(linuxKeys("⌃⇧Tab")).toBe("Ctrl+Shift+Tab");
    expect(linuxKeys("⌘[ / ⌘] or ⌥← / ⌥→")).toBe("Ctrl+[ / Ctrl+] or Alt+← / Alt+→");
    expect(linuxKeys("⌘= / ⌘- or ⌘ + scroll")).toBe("Ctrl+= / Ctrl+- or Ctrl+scroll");
    expect(linuxKeys("⌥Enter")).toBe("Alt+Enter");
  });

  it("uses the Linux keys where the rule does not fit", () => {
    expect(linuxKeys("⌃⌘N")).toBe("Ctrl+Alt+Shift+N");
    expect(linuxKeys("Zoom in (⌘+)")).toBe("Zoom in (Ctrl+=)");
  });

  it("leaves labels without macOS glyphs alone", () => {
    expect(linuxKeys("F2")).toBe("F2");
    expect(linuxKeys("Ctrl+Tab")).toBe("Ctrl+Tab");
  });
});
