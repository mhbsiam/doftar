import { describe, expect, it } from "vitest";
import { gridTemplate, narrowTemplate, shownColumns } from "./listColumns";

describe("list columns", () => {
  it("keeps the display order and always shows Name", () => {
    expect(shownColumns(["size", "created"])).toEqual(["name", "created", "size"]);
    expect(shownColumns([])).toEqual(["name"]);
  });

  it("lets Name fill until it is sized, then the last column fills", () => {
    expect(gridTemplate(["name", "size"], {})).toBe("minmax(17.143rem, 1fr) 7.857rem");
    expect(gridTemplate(["name", "size"], { name: 20, size: 1 })).toBe("20rem minmax(4rem, 1fr)");
  });

  it("drops the extra columns when narrow", () => {
    expect(narrowTemplate(["name", "modified", "type", "size", "tags"])).toBe("minmax(10rem, 1fr) 11.429rem 6.429rem");
  });
});
