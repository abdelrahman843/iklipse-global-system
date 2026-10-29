import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cssFont, layoutText, lineHeightOf, setMeasure, textBox, transformText } from "../text";
import type { TextProps } from "../types";
import { useFakeMeasure } from "./helpers";

beforeAll(useFakeMeasure);
afterAll(() => setMeasure(null));

// fontSize 10 → 5 px per glyph, line height 12 (auto)
const T = (content: string, p: Partial<TextProps> = {}): TextProps => ({
  content,
  fontFamily: "Inter",
  fontWeight: 400,
  fontSize: 10,
  align: "left",
  resize: "auto-height",
  ...p,
});
const lines = (t: TextProps, w?: number) => layoutText(t, w).lines.map((l) => l.text);

describe("layoutText", () => {
  it("wraps greedily on spaces and trims trailing space", () => {
    expect(lines(T("hello world foo"), 60)).toEqual(["hello world", "foo"]);
    expect(lines(T("hello world foo"), 1000)).toEqual(["hello world foo"]);
  });
  it("keeps explicit newlines, including empty lines", () => {
    const l = layoutText(T("a\nbb\n\nccc"));
    expect(l.lines.map((x) => x.text)).toEqual(["a", "bb", "", "ccc"]);
    expect(l.height).toBe(48);
    expect(l.width).toBe(15);
  });
  it("splits a word longer than the line by characters", () => {
    expect(lines(T("abcdefghij"), 20)).toEqual(["abcd", "efgh", "ij"]);
    expect(lines(T("hi abcdefghij"), 20)).toEqual(["hi", "abcd", "efgh", "ij"]);
  });
  it("measures with letter spacing", () => {
    expect(layoutText(T("abcd", { letterSpacing: 1 })).width).toBe(24);
  });
  it("applies text transforms before measuring", () => {
    expect(lines(T("hello there", { transform: "upper" }))).toEqual(["HELLO THERE"]);
    expect(transformText("hello big world", "title")).toBe("Hello Big World");
    expect(transformText("ABC", "lower")).toBe("abc");
  });
  it("uses explicit line heights", () => {
    expect(lineHeightOf({ fontSize: 10, lineHeight: 20 })).toBe(20);
    expect(lineHeightOf({ fontSize: 10, lineHeight: null })).toBe(12);
    expect(layoutText(T("a\nb", { lineHeight: 20 })).height).toBe(40);
  });
  it("builds a CSS font string (quoted families with spaces)", () => {
    expect(cssFont({ fontFamily: "Open Sans", fontWeight: 700, fontSize: 12, italic: true })).toBe('italic 700 12px "Open Sans", system-ui, sans-serif');
  });
});

describe("textBox", () => {
  const content = "hello world foo";
  it("auto-width grows to the longest line and ignores w", () => {
    const b = textBox(T(content, { resize: "auto-width" }), 10, 10);
    expect([b.w, b.h]).toEqual([75, 12]);
    expect(b.layout.lines).toHaveLength(1);
  });
  it("auto-height keeps w and grows down", () => {
    const b = textBox(T(content, { resize: "auto-height" }), 60, 5);
    expect([b.w, b.h]).toEqual([60, 24]);
  });
  it("fixed keeps w and h but still wraps", () => {
    const b = textBox(T(content, { resize: "fixed" }), 60, 5);
    expect([b.w, b.h]).toEqual([60, 5]);
    expect(b.layout.lines).toHaveLength(2);
  });
});
