import { memo } from "react";

const DIGITS = "0123456789";

/** The ones place keeps its column when a digit is added or removed. Screen readers get the plain number. */
export const RollingNumber = memo(function RollingNumber({ value }: { value: number }) {
  const text = String(Math.max(0, Math.trunc(value)));
  const places = text.length;
  return (
    <span className="roll">
      <span className="sr-only">{text}</span>
      <span className="roll-digits" aria-hidden>
        {Array.from(text, (ch, i) => (
          <span key={places - i} className="roll-place">
            <span
              className="roll-column"
              style={{ transform: `translateY(${-Number(ch) * 10}%)` }}
            >
              {Array.from(DIGITS, (d) => (
                <span key={d}>{d}</span>
              ))}
            </span>
          </span>
        ))}
      </span>
    </span>
  );
});
