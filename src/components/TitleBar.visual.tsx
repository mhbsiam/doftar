import { afterEach, expect, test } from "vitest";
import { TitleBar } from "./TitleBar";
import { useTabs } from "../stores/tabs";
import { mount, settle, SPLIT } from "../test/mount";

let unmount = () => {};

/** WebKit reports the right inset mid-animation as `12px` or `calc(40% + 3px)`. */
function rightInset(clip: string, width: number): number {
  const m = /^inset\(\S+ (?:calc\(([-\d.]+)% \+ ([-\d.]+)px\)|([-\d.]+)px)/.exec(clip);
  expect(m, clip).not.toBeNull();
  return m![3] !== undefined ? parseFloat(m![3]) : (parseFloat(m![1]) / 100) * width + parseFloat(m![2]);
}
afterEach(() => unmount());

/**
 * Closes tab `id`, stops the tab animations after `ms`, and returns how far
 * the closing tab reaches past what slides in after it.
 */
async function overlapAfter(id: number, ms: number) {
  useTabs.getState().closeTab(id);
  const el = document.querySelector<HTMLElement>(`.tab[data-tab-id="${id}"]`)!;
  // The tab starts to collapse once the page swap shows on screen.
  for (let i = 0; i < 60 && el.getAnimations().length === 0; i++) await new Promise(requestAnimationFrame);
  const anims = document
    .getAnimations()
    .filter((a) => {
      const t = (a.effect as KeyframeEffect | null)?.target;
      return t instanceof HTMLElement && t.closest(".titlebar") && !(a instanceof CSSTransition);
    });
  expect(el.getAnimations().length).toBeGreaterThan(0);
  for (const a of anims) {
    a.pause();
    a.currentTime = ms;
  }
  const box = el.getBoundingClientRect();
  const visibleRight = box.right - rightInset(getComputedStyle(el).clipPath, box.width);
  const after = (el.nextElementSibling as HTMLElement | null) ?? document.querySelector<HTMLElement>(".new-tab")!;
  const overlap = visibleRight - after.getBoundingClientRect().left;
  for (const a of anims) a.finish();
  await settle(500);
  return overlap;
}

test("a closing tab isn't run over by what slides in after it", async () => {
  ({ unmount } = await mount(<TitleBar />, SPLIT));
  const s = useTabs.getState();
  s.newTab();
  s.newTab();
  await settle(500);
  const [, middle, last] = useTabs.getState().tabs.map((t) => t.id);

  useTabs.getState().setActive(middle);
  await settle(500);
  expect(await overlapAfter(middle, 140)).toBeLessThanOrEqual(2);

  useTabs.getState().setActive(last);
  await settle(500);
  expect(await overlapAfter(last, 100)).toBeLessThanOrEqual(2);
});

test("with more tabs than fit, the strip scrolls and + stays in view", async () => {
  ({ unmount } = await mount(<TitleBar />, SPLIT));
  const s = useTabs.getState();
  for (let i = 0; i < 12; i++) s.newTab();
  await settle(600);
  const list = document.querySelector<HTMLElement>(".tablist")!;
  const plus = document.querySelector<HTMLElement>(".new-tab")!;
  expect(list.scrollWidth).toBeGreaterThan(list.clientWidth);
  expect(plus.getBoundingClientRect().right).toBeLessThanOrEqual(SPLIT);
  const active = document.querySelector<HTMLElement>('.tab[aria-selected="true"]')!;
  const a = active.getBoundingClientRect(), l = list.getBoundingClientRect();
  expect(a.left).toBeGreaterThanOrEqual(l.left - 1);
  expect(a.right).toBeLessThanOrEqual(l.right + 1);
  list.scrollLeft = 0;
  await settle(100);
  expect(plus.getBoundingClientRect().right).toBeLessThanOrEqual(SPLIT);
});
