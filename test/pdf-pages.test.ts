// @ts-nocheck -- Node-only test (reads a fixture file)
import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { pdfPageCount } from "../public/js/files.js";

it("counts a PDF's pages from the file", async () => {
  const bytes = new Uint8Array(fs.readFileSync(path.join(__dirname, "fixtures", "invoices", "sunburst-invoice.pdf")));
  expect(await pdfPageCount(bytes)).toBe(1);
  const fake = new TextEncoder().encode("1 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 12 >> endobj 3 0 obj << /Type /Page >> endobj");
  expect(await pdfPageCount(fake)).toBe(12);
  expect(await pdfPageCount(new TextEncoder().encode("nothing here"))).toBe(0);
  // Pages listed inside compressed object streams, as Chrome, Word and accounting software write them
  const packed = new Uint8Array(fs.readFileSync(path.join(__dirname, "fixtures", "invoices", "seven-pages-compressed.pdf")));
  expect(await pdfPageCount(packed)).toBe(7);
});
