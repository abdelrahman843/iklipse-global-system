import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { N, layout, makeDoc, solid, useFakeMeasure } from "./helpers";

// Image signing and saving talk to the network / the apps: stand-ins.
vi.mock("@/lib/wb/api", () => ({
  imageUrl: vi.fn(async (path: string) => (path === "missing.png" ? null : `https://signed.example/${path}`)),
  cachedImageUrl: vi.fn(() => null),
}));
vi.mock("@/lib/nativeApp", () => ({ saveBlob: vi.fn(async () => {}) }));

const { buildSvg, exportFileNames, exportSvg, fitScale, pdfFromJpegs, pdfPageSize, safeFileName, blobToDataUrl } = await import("../exporter");
const { imageUrl } = await import("@/lib/wb/api");

beforeAll(useFakeMeasure);
afterEach(() => vi.unstubAllGlobals());

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function doc() {
  return makeDoc([
    N("frame", "F", null, { name: "Card", x: 300, y: 400, w: 200, h: 100, fills: [solid("#FFFFFF")], layout: layout({ gap: 10, padding: { t: 10, r: 10, b: 10, l: 10 } }) }),
    N("rect", "R", "F", { order: 1, w: 30, h: 30, radius: 4, fills: [solid("#FF0000")] }),
    N("text", "T", "F", { order: 2, text: { content: "Hello <world> & co", fontFamily: "Inter", fontWeight: 400, fontSize: 10, align: "left", resize: "auto-width" } }),
    N("image", "I", "F", { order: 3, w: 40, h: 20, image: { src: "board/pic.png", nw: 40, nh: 20, fit: "fill" } }),
    N("image", "M", "F", { order: 4, w: 10, h: 10, image: { src: "missing.png", nw: 10, nh: 10, fit: "fill" } }),
    N("ellipse", "E", null, { name: "Dot", x: 0, y: 0, w: 50, h: 30, rotation: 90 }),
  ]);
}

function stubFetch() {
  const fetchMock = vi.fn(async () => new Response(new Blob([PNG], { type: "image/png" })));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("exportSvg", () => {
  it("is a standalone SVG of the layer at its own origin, images inlined", async () => {
    const fetchMock = stubFetch();
    const svg = await exportSvg(doc(), ["F"]);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('width="200" height="100" viewBox="0 0 200 100"');
    // At the origin, not at its page position.
    expect(svg).toContain('transform="translate(0 0)"');
    expect(svg).toContain('fill="#FF0000"');
    expect(svg).toContain("<text");
    expect(svg).toContain("Hello &lt;world&gt; &amp; co");
    const b64 = btoa(String.fromCharCode(...PNG));
    expect(svg).toContain(`href="data:image/png;base64,${b64}"`);
    expect(svg).not.toContain("signed.example");
    expect(imageUrl).toHaveBeenCalledWith("board/pic.png");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The missing image draws as the grey placeholder.
    expect(svg).toContain('fill="#E5E5E5"');
    // Well-formed XML.
    expect(svg.match(/<svg/g)).toHaveLength(1);
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  it("puts several layers side by side; rotated layers get the box around them", async () => {
    stubFetch();
    const r = await buildSvg(doc(), ["F", "E"], { gap: 20, background: "#000" });
    // Dot is 50 x 30 turned 90° → a 30 x 50 box after Card (200) + gap (20); turning about its centre, it sits at x = 220 + (30 - 50) / 2.
    expect([r.w, r.h]).toEqual([250, 100]);
    expect(r.svg).toContain('<rect width="250" height="100" fill="#000"/>');
    expect(r.svg).toContain("translate(210 10) rotate(90 25 15)");
  });

  it("throws when nothing exists", async () => {
    await expect(exportSvg(doc(), ["nope"])).rejects.toThrow(/nothing to export/);
  });

  it("can leave images out", async () => {
    const fetchMock = stubFetch();
    await exportSvg(doc(), ["F"], { inlineImages: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("pdf", () => {
  const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");

  it("one page per layer, valid header, xref and trailer", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 0xff, 0xd9]);
    const bytes = pdfFromJpegs([
      { jpeg, w: 400, h: 200, layerW: 200, layerH: 100 },
      { jpeg, w: 100, h: 100, layerW: 50, layerH: 50 },
      { jpeg, w: 3000, h: 1000, layerW: 3000, layerH: 1000 },
    ]);
    const s = latin1(bytes);
    expect(s.startsWith("%PDF-1.")).toBe(true);
    expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(s).toContain("/Count 3");
    expect(s.match(/\/Type \/Page\b(?!s)/g)).toHaveLength(3);
    expect(s).toContain("/MediaBox [0 0 150 75]");
    expect(s).toContain("/Width 400 /Height 200");
    expect(s.match(/\/Filter \/DCTDecode/g)).toHaveLength(3);
    // startxref points at the xref table, and every offset at its object.
    const startxref = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(startxref, startxref + 4)).toBe("xref");
    const offsets = s
      .slice(startxref)
      .split("\n")
      .filter((l) => / 00000 n $/.test(l))
      .map((l) => Number(l.slice(0, 10)));
    expect(offsets).toHaveLength(2 + 3 * 3);
    offsets.forEach((o, i) => expect(s.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  });

  it("page size: 0.75 pt per px, long side capped at 1440 pt", () => {
    expect(pdfPageSize(200, 100)).toEqual({ pw: 150, ph: 75 });
    expect(pdfPageSize(3000, 1000)).toEqual({ pw: 1440, ph: 480 });
  });
});

describe("helpers", () => {
  it("file names: sanitised, unique, scale suffix for rasters", () => {
    expect(safeFileName('a/b:c*?"<>|d')).toBe("a b c d");
    expect(safeFileName("  ...  ")).toBe("Export");
    expect(exportFileNames(["Card", "card", "Home/Hero", ""], "png", 2)).toEqual(["Card@2x.png", "card 2@2x.png", "Home Hero@2x.png", "Export@2x.png"]);
    expect(exportFileNames(["Card"], "svg", 2)).toEqual(["Card.svg"]);
    expect(exportFileNames(["Card"], "jpg", 1)).toEqual(["Card.jpg"]);
  });

  it("caps the raster scale to what browsers allow", () => {
    expect(fitScale(100, 100, 2)).toBe(2);
    expect(fitScale(10000, 10000, 4)).toBeCloseTo(0.4);
    expect(fitScale(20000, 10, 1)).toBeCloseTo(16384 / 20000);
  });

  it("blobToDataUrl encodes bytes as base64", async () => {
    expect(await blobToDataUrl(new Blob([new Uint8Array([104, 105])], { type: "text/plain" }))).toBe("data:text/plain;base64,aGk=");
  });
});
