export const BASE_FONT_PX = 14;

export const TEXT_SCALES: { value: number; label: string }[] = [
  { value: 1, label: "Default" },
  { value: 1.15, label: "Large" },
  { value: 1.3, label: "Larger" },
];

export function applyTextScale(scale: number) {
  document.documentElement.style.fontSize = `${BASE_FONT_PX * scale}px`;
}

export function textScale(): number {
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return (Number.isFinite(px) ? px : BASE_FONT_PX) / BASE_FONT_PX;
}

export const rem = (designPx: number) => `${designPx / BASE_FONT_PX}rem`;
