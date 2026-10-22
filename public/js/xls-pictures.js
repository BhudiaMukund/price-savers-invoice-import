// Pictures inside old Excel files (.xls, the binary format). SheetJS reads the cells but not the pictures,
// so this reads them directly:
//   1. The file is an OLE "compound file" with a Workbook stream.
//   2. The stream is a list of records. The picture data sits in the MsoDrawingGroup records (the globals),
//      and where each picture sits is in the MsoDrawing records of each sheet (an "anchor": from row/column
//      to row/column).
//   3. Both are Escher (Office drawing) records, which are nested containers.
// Pure functions on bytes, so the tests run them without a browser. Anything unexpected gives no pictures
// rather than an error: the cells are still read.

const u16 = (d, p) => d[p] | (d[p + 1] << 8);
const u32 = (d, p) => (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> 0;

/* ------------------------------------------------------------------ compound file */

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
export const isOle = (b) => b.length > 512 && OLE_MAGIC.every((v, i) => b[i] === v);

/** The bytes of a stream (by name, ignoring case) in an OLE compound file, or null. */
export function readOleStream(b, wanted) {
  if (!isOle(b)) return null;
  const sectorSize = 1 << u16(b, 0x1e);
  const miniSize = 1 << u16(b, 0x20);
  const cutoff = u32(b, 0x38);
  const at = (sector) => (sector + 1) * sectorSize;
  const sectorOf = (sector) => b.subarray(at(sector), at(sector) + sectorSize);

  // The FAT (which sector follows which): its own sectors are listed in the header, then in the DIFAT chain.
  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const s = u32(b, 0x4c + i * 4);
    if (s < 0xfffffffa) fatSectors.push(s);
  }
  let dif = u32(b, 0x44);
  for (let guard = 0; dif < 0xfffffffa && guard < 1000; guard++) {
    const sec = sectorOf(dif);
    for (let i = 0; i < sectorSize / 4 - 1; i++) {
      const s = u32(sec, i * 4);
      if (s < 0xfffffffa) fatSectors.push(s);
    }
    dif = u32(sec, sectorSize - 4);
  }
  const fat = [];
  for (const s of fatSectors) {
    const sec = sectorOf(s);
    for (let i = 0; i < sectorSize / 4; i++) fat.push(u32(sec, i * 4));
  }
  const chain = (start) => {
    const out = [];
    for (let s = start, n = 0; s < 0xfffffffa && n < fat.length + 1; s = fat[s], n++) out.push(s);
    return out;
  };
  const join = (parts, size) => {
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) (out.set(p, o), (o += p.length));
    return size === undefined ? out : out.subarray(0, size);
  };

  // Directory entries: 128 bytes each.
  const dir = join(chain(u32(b, 0x30)).map(sectorOf));
  let root = null;
  let entry = null;
  for (let p = 0; p + 128 <= dir.length; p += 128) {
    const len = u16(dir, p + 0x40);
    if (len < 2) continue;
    let name = "";
    for (let i = 0; i < len / 2 - 1; i++) name += String.fromCharCode(u16(dir, p + i * 2));
    const type = dir[p + 0x42];
    const e = { name, type, start: u32(dir, p + 0x74), size: u32(dir, p + 0x78) };
    if (type === 5) root = e;
    else if (type === 2 && name.toLowerCase() === wanted.toLowerCase()) entry = e;
  }
  if (!entry) return null;
  if (entry.size >= cutoff) return join(chain(entry.start).map(sectorOf), entry.size);

  // Small streams live in the "mini stream" (inside the root entry's data), 64 bytes at a time.
  if (!root) return null;
  const mini = join(chain(root.start).map(sectorOf));
  const miniFat = [];
  for (const s of chain(u32(b, 0x3c))) {
    const sec = sectorOf(s);
    for (let i = 0; i < sectorSize / 4; i++) miniFat.push(u32(sec, i * 4));
  }
  const parts = [];
  for (let s = entry.start, n = 0; s < 0xfffffffa && n < miniFat.length + 1; s = miniFat[s], n++) parts.push(mini.subarray(s * miniSize, (s + 1) * miniSize));
  return join(parts, entry.size);
}

/* ------------------------------------------------------------------ Escher (Office drawing) records */

/** Walk Escher records in d[start, end): fn(type, inst, bodyStart, bodyEnd) for each leaf; containers are entered. */
function walk(d, start, end, fn, depth = 0) {
  end = Math.min(end, d.length);
  for (let p = start; p + 8 <= end; ) {
    const verInst = u16(d, p);
    const type = u16(d, p + 2);
    const len = u32(d, p + 4);
    const body = p + 8;
    if (type < 0xf000) return; // not an Escher record: the data is damaged or isn't drawing data
    const bodyEnd = Math.min(end, body + len);
    if ((verInst & 0xf) === 0xf) {
      if (depth < 12) {
        fn(type, verInst >> 4, body, bodyEnd, true);
        walk(d, body, bodyEnd, fn, depth + 1);
      }
    } else fn(type, verInst >> 4, body, bodyEnd, false);
    p = body + len;
  }
}

const BLIP = {
  0xf01d: { kind: "jpeg", ext: "jpg", ids: new Set([0x46a, 0x6e2, 0x46b, 0x6e3]), two: new Set([0x46b, 0x6e3]) },
  0xf01e: { kind: "png", ext: "png", ids: new Set([0x6e0, 0x6e1]), two: new Set([0x6e1]) },
  0xf01f: { kind: "dib", ext: "bmp", ids: new Set([0x7a8, 0x7a9]), two: new Set([0x7a9]) },
};

/** A bitmap as Excel stores it (no file header) with the 14-byte header added, so a browser can open it. */
function bmpFromDib(dib) {
  if (dib.length < 40) return null;
  const size = u32(dib, 0);
  if (![40, 52, 56, 108, 124].includes(size)) return null;
  const bits = u16(dib, 14);
  const compression = u32(dib, 16);
  const used = u32(dib, 32);
  const palette = bits <= 8 ? (used || 1 << bits) * 4 : 0;
  const masks = size === 40 && compression === 3 ? 12 : 0;
  const offset = 14 + size + palette + masks;
  const out = new Uint8Array(14 + dib.length);
  out[0] = 0x42;
  out[1] = 0x4d;
  new DataView(out.buffer).setUint32(2, out.length, true);
  new DataView(out.buffer).setUint32(10, offset, true);
  out.set(dib, 14);
  return out;
}

/** The picture bytes in a BLIP record, or { unsupported: true } (EMF, WMF, PICT). */
function readBlip(d, p, end) {
  if (p + 8 > end) return null;
  const inst = u16(d, p) >> 4;
  const type = u16(d, p + 2);
  const len = u32(d, p + 4);
  const body = p + 8;
  const spec = BLIP[type];
  if (!spec) return type >= 0xf018 && type <= 0xf117 ? { unsupported: true } : null;
  const skip = (spec.two.has(inst) ? 32 : 16) + 1;
  const bytes = d.slice(body + skip, Math.min(end, body + len));
  if (spec.kind === "dib") {
    const bmp = bmpFromDib(bytes);
    return bmp ? { ext: "bmp", bytes: bmp } : { unsupported: true };
  }
  const magic = spec.kind === "jpeg" ? bytes[0] === 0xff && bytes[1] === 0xd8 : bytes[0] === 0x89 && bytes[1] === 0x50;
  return magic ? { ext: spec.ext, bytes } : { unsupported: true };
}

/** The pictures stored in the workbook, in order: index 1 of a shape's "picture" property is the first. */
function readStore(group) {
  const store = [];
  walk(group, 0, group.length, (type, inst, body, end, container) => {
    if (type === 0xf007 && !container) {
      // File BLIP Store Entry: 36 bytes of details, a name, then the picture itself.
      const nameLen = group[body + 33];
      const size = u32(group, body + 20);
      store.push(size ? readBlip(group, body + 36 + nameLen, end) : null);
    }
  });
  return store;
}

/** Pictures on one sheet's drawing: [{ pic (1-based index into the store), from: {row, rowOff}, to: {row, rowOff} }]. */
function readShapes(draw) {
  const shapes = [];
  let cur = null;
  walk(draw, 0, draw.length, (type, inst, body, end, container) => {
    if (type === 0xf004 && container) {
      cur = { pic: 0, anchor: null };
      shapes.push(cur);
    } else if (cur && type === 0xf00b && !container) {
      // Properties: 6 bytes each. 0x104 is the picture.
      for (let i = 0; i < inst && body + i * 6 + 6 <= end; i++) {
        const id = u16(draw, body + i * 6) & 0x3fff;
        if (id === 0x104) cur.pic = u32(draw, body + i * 6 + 2);
      }
    } else if (cur && type === 0xf010 && !container && end - body >= 18) {
      // Client anchor: flags, then (column, offset, row, offset) for the top-left and bottom-right corners.
      cur.anchor = {
        from: { col: u16(draw, body + 2), row: u16(draw, body + 6), rowOff: u16(draw, body + 8) },
        to: { col: u16(draw, body + 10), row: u16(draw, body + 14), rowOff: u16(draw, body + 16) },
      };
    }
  });
  return shapes.filter((s) => s.pic > 0 && s.anchor);
}

/** Rows a picture covers, the row holding most of it first (the same idea as for .xlsx). Offsets are 1/256 of a row. */
function rowsCovered(from, to) {
  if (to.row <= from.row) return [from.row];
  const parts = [];
  for (let r = from.row; r <= to.row && r < from.row + 60; r++) {
    const top = r === from.row ? Math.min(from.rowOff, 256) : 0;
    const bottom = r === to.row ? Math.min(to.rowOff, 256) : 256;
    parts.push({ r, size: Math.max(0, bottom - top) });
  }
  return parts.sort((a, b) => b.size - a.size || a.r - b.r).map((p) => p.r);
}

/* ------------------------------------------------------------------ the workbook */

/**
 * Pictures in an .xls file: { bySheet: { [sheetName]: [{ row, col, rows, pic: { ext, bytes, index } }] }, unsupported }.
 * The same picture used on several rows has the same `index`, so callers can share one copy.
 */
export function xlsPictures(fileBytes) {
  const out = { bySheet: {}, unsupported: 0 };
  const wb = readOleStream(fileBytes, "Workbook") ?? readOleStream(fileBytes, "Book");
  if (!wb) return out;

  // Records: 2 bytes type, 2 bytes length. CONTINUE (0x3C) records carry on the one before them.
  const sheets = []; // { name, pos, type }
  const groups = []; // drawing group data (globals)
  const draws = []; // { pos, data } per MsoDrawing record
  let last = null; // the record a CONTINUE belongs to
  for (let p = 0; p + 4 <= wb.length; ) {
    const t = u16(wb, p);
    const len = u16(wb, p + 2);
    const body = wb.subarray(p + 4, p + 4 + len);
    if (t === 0x85 && len >= 8) {
      const cch = body[6];
      const wide = body[7] & 1;
      let name = "";
      for (let i = 0; i < cch && 8 + (wide ? i * 2 + 1 : i) < body.length; i++) name += String.fromCharCode(wide ? u16(body, 8 + i * 2) : body[8 + i]);
      sheets.push({ name, pos: u32(body, 0), type: body[5] });
      last = null;
    } else if (t === 0xeb) {
      last = { chunks: [body] };
      groups.push(last);
    } else if (t === 0xec) {
      last = { pos: p, chunks: [body] };
      draws.push(last);
    } else if (t === 0x3c && last) last.chunks.push(body);
    else last = null;
    p += 4 + len;
  }
  const join = (chunks) => {
    const o = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
    let n = 0;
    for (const c of chunks) (o.set(c, n), (n += c.length));
    return o;
  };
  if (!groups.length || !draws.length) return out;
  const store = readStore(join(groups.flatMap((g) => g.chunks)));
  if (!store.length) return out;

  // A sheet's drawing is spread over several MsoDrawing records: join the ones inside its part of the stream.
  const worksheets = sheets.filter((s) => s.type === 0).sort((a, b) => a.pos - b.pos);
  for (let i = 0; i < worksheets.length; i++) {
    const sh = worksheets[i];
    const next = worksheets[i + 1]?.pos ?? Infinity;
    const mine = draws.filter((d) => d.pos >= sh.pos && d.pos < next);
    if (!mine.length) continue;
    const list = [];
    for (const s of readShapes(join(mine.flatMap((d) => d.chunks)))) {
      const pic = store[s.pic - 1];
      if (!pic) continue;
      if (pic.unsupported) {
        out.unsupported++;
        continue;
      }
      list.push({ row: s.anchor.from.row, col: s.anchor.from.col, rows: rowsCovered(s.anchor.from, s.anchor.to), pic: { ext: pic.ext, bytes: pic.bytes, index: s.pic } });
    }
    list.sort((a, b) => a.row - b.row || a.col - b.col);
    if (list.length) out.bySheet[sh.name] = list;
  }
  return out;
}
