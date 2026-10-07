'use strict';
/* خروجی ورد (.docx) و اکسل (.xlsx) بدون هیچ وابستگی خارجی (کاملاً آفلاین).
   رندرر سند چاپی را به «مدل سند» (JSON) تبدیل می‌کند؛ این ماژول در main آن را به فایل OOXML واقعی تبدیل می‌کند.
   مدل: { title, currency?, landscape?, blocks:[ {t:'p',runs:[{text,b,i,color,size}],align,size,b,color,after} | {t:'img',data,w,h,align} |
          {t:'table',header:bool,widths?:[],rows:[{header?:bool,cells:[{blocks?:[...],text?,colspan?,bg?,b?,align?}]}]} ] } */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const Kind = require('./kind');
const { textOf, cellBlocks, parseNumber, chooseKind } = Kind;

/* ---------------- ZIP ---------------- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zip(entries) {
  const now = new Date(), dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [], central = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8'), crc = crc32(raw);
    const deflated = zlib.deflateRawSync(raw), useDeflate = deflated.length < raw.length, body = useDeflate ? deflated : raw, method = useDeflate ? 8 : 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8); lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10); ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/* ---------------- ابزارها ---------------- */
const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const RTL_RE = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const FONT = 'Tahoma';
const hex6 = (c) => { const m = /^#?([0-9a-fA-F]{6})$/.exec(String(c || '')); return m ? m[1].toUpperCase() : null; };
function dataUrlToBuf(url) { const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(url || '')); if (!m) return null; const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64'); return buf.length > 20 && buf.length < 12 * 1024 * 1024 ? { buf, ext: m[1] === 'png' ? 'png' : 'jpeg' } : null; }
function imageSize(buf, ext) {
  try {
    if (ext === 'png') { if (buf.readUInt32BE(0) !== 0x89504e47) return null; return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; }
    let i = 2; while (i < buf.length - 9) { if (buf[i] !== 0xFF) { i++; continue; } const m = buf[i + 1]; if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }; i += 2 + buf.readUInt16BE(i + 2); }
  } catch (_) { /* ignore */ }
  return null;
}
function validateModel(model) {
  if (!model || typeof model !== 'object' || !Array.isArray(model.blocks)) throw new Error('مدل سند نامعتبر است.');
  if (model.blocks.length > 5000) throw new Error('سند بسیار بزرگ است.');
  let cells = 0, img = 0;
  const walk = (bl) => bl.forEach(b => { if (b.t === 'table') { if (!Array.isArray(b.rows)) throw new Error('جدول نامعتبر است.'); b.rows.forEach(r => { if (!Array.isArray(r.cells)) throw new Error('ردیف جدول نامعتبر است.'); cells += r.cells.length; r.cells.forEach(c => { if (c.blocks) walk(c.blocks); }); }); } else if (b.t === 'img') img += String(b.data || '').length; });
  walk(model.blocks); if (cells > 300000) throw new Error('جدول بسیار بزرگ است.'); if (img > 60 * 1024 * 1024) throw new Error('تصاویر سند بسیار حجیم است.');
}

/* ---------------- DOCX ---------------- */
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
function buildDocx(model) {
  validateModel(model);
  const media = []; let docId = 1;
  const tblCols = Math.max(0, ...model.blocks.filter(b => b.t === 'table').map(b => Math.max(0, ...b.rows.map(r => r.cells.reduce((n, c) => n + (c.colspan || 1), 0)))));
  const landscape = model.landscape === true || (model.landscape !== false && tblCols >= 8);
  const PAGE_W = landscape ? 16838 : 11906, PAGE_H = landscape ? 11906 : 16838, MARGIN = 720, CONTENT = PAGE_W - 2 * MARGIN;
  const maxImgPx = (dxa) => Math.floor(dxa / 15);

  const runXml = (r, base) => {
    const text = String(r.text === undefined || r.text === null ? '' : r.text); if (!text) return '';
    const size = r.size || base.size || 10.5, color = hex6(r.color || base.color), bold = r.b !== undefined ? r.b : base.b, ital = r.i;
    const sz = Math.round(size * 2), rtl = RTL_RE.test(text);
    const rpr = `<w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:eastAsia="${FONT}" w:cs="${FONT}"/>` + (bold ? '<w:b/><w:bCs/>' : '') + (ital ? '<w:i/><w:iCs/>' : '') + (color ? `<w:color w:val="${color}"/>` : '') + `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>` + (rtl ? '<w:rtl/>' : '');
    return text.split('\n').map((line, i) => `<w:r><w:rPr>${rpr}</w:rPr>${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${esc(line)}</w:t></w:r>`).join('');
  };
  const pXml = (b) => {
    const base = { size: b.size, color: b.color, b: b.b };
    const jc = b.align === 'center' ? '<w:jc w:val="center"/>' : b.align === 'left' ? '<w:jc w:val="right"/>' : b.align === 'justify' ? '<w:jc w:val="both"/>' : '';
    const before = Math.max(0, Math.min(600, Math.round((b.before || 0) * 20))), after = Math.max(0, Math.min(600, Math.round((b.after === undefined ? 4 : b.after) * 20)));
    const shd = hex6(b.bg) ? `<w:shd w:val="clear" w:color="auto" w:fill="${hex6(b.bg)}"/>` : '';
    return `<w:p><w:pPr>${b.keepNext ? '<w:keepNext/>' : ''}${shd}<w:bidi/><w:spacing w:before="${before}" w:after="${after}"/>${jc}</w:pPr>${(b.runs || []).map(r => runXml(r, base)).join('')}</w:p>`;
  };
  const imgXml = (b, maxDxa) => {
    const d = dataUrlToBuf(b.data); if (!d) return '';
    const sz = imageSize(d.buf, d.ext); if (!sz || !sz.w || !sz.h) return '';
    let w = Number(b.w) || 0, h = Number(b.h) || 0; if (w && !h) h = Math.round(w * sz.h / sz.w); else if (h && !w) w = Math.round(h * sz.w / sz.h); else if (!w && !h) { w = sz.w; h = sz.h; }
    const maxW = maxImgPx(maxDxa || CONTENT);
    if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
    const id = ++docId, rid = 'rIdImg' + id; media.push({ rid, name: `image${id}.${d.ext}`, buf: d.buf });
    const cx = Math.round(w * 9525), cy = Math.round(h * 9525);
    const jc = b.align === 'center' ? '<w:jc w:val="center"/>' : b.align === 'left' ? '<w:jc w:val="right"/>' : '';
    return `<w:p><w:pPr><w:bidi/><w:spacing w:before="0" w:after="60"/>${jc}</w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  };
  const blocksXml = (blocks, maxDxa) => { const out = blocks.map(b => b.t === 'p' ? pXml(b) : b.t === 'img' ? imgXml(b, maxDxa) : b.t === 'table' ? tblXml(b, maxDxa) : '').join(''); return out || '<w:p><w:pPr><w:bidi/></w:pPr></w:p>'; };
  const tblXml = (b, totalW) => {
    totalW = totalW || CONTENT;
    const ncols = Math.max(1, ...b.rows.map(r => r.cells.reduce((n, c) => n + (c.colspan || 1), 0)));
    let weights = Array.isArray(b.widths) && b.widths.length === ncols ? b.widths.map(w => Math.max(0.02, Number(w) || 0)) : null;
    if (!weights) { weights = new Array(ncols).fill(4); b.rows.forEach(r => { let ci = 0; r.cells.forEach(c => { const span = c.colspan || 1; if (span === 1) { const len = Math.min(48, textOf(cellBlocks(c)).split('\n').reduce((m, l) => Math.max(m, l.length), 0)); weights[ci] = Math.max(weights[ci], len + 3); } ci += span; }); }); }
    const sum = weights.reduce((a, c) => a + c, 0), grid = weights.map(w => Math.max(500, Math.floor(totalW * w / sum))), gsum = grid.reduce((a, c) => a + c, 0), W = Math.min(totalW, gsum);
    const border = (n) => `<w:${n} w:val="single" w:sz="4" w:space="0" w:color="888888"/>`;
    const bordered = b.bordered !== false;
    let xml = `<w:tbl><w:tblPr><w:bidiVisual/><w:tblW w:w="${W}" w:type="dxa"/>${bordered ? `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders>` : ''}<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${grid.map(g => `<w:gridCol w:w="${g}"/>`).join('')}</w:tblGrid>`;
    b.rows.forEach((r, ri) => {
      const isHead = r.header === true || (b.header && ri === 0 && r.header !== false);
      xml += `<w:tr><w:trPr><w:cantSplit/>${isHead ? '<w:tblHeader/>' : ''}</w:trPr>`; let ci = 0;
      r.cells.forEach(c => {
        const span = Math.max(1, Math.min(ncols - ci, c.colspan || 1)), w = grid.slice(ci, ci + span).reduce((a, g) => a + g, 0); ci += span;
        const bg = hex6(c.bg) || (isHead ? 'EEF1F6' : null);
        let blocks = cellBlocks(c); if (isHead || c.b) blocks = blocks.map(x => x.t === 'p' ? Object.assign({}, x, { b: true }) : x);
        xml += `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}${bg ? `<w:shd w:val="clear" w:color="auto" w:fill="${bg}"/>` : ''}<w:vAlign w:val="top"/></w:tcPr>${blocksXml(blocks.map(x => x.t === 'p' ? Object.assign({ after: 1 }, x) : x), w - 160)}</w:tc>`;
      });
      xml += '</w:tr>';
    });
    return xml + '</w:tbl><w:p><w:pPr><w:bidi/><w:spacing w:before="0" w:after="80"/></w:pPr></w:p>';
  };
  const body = blocksXml(model.blocks, CONTENT);
  const sect = `<w:sectPr><w:footerReference w:type="default" r:id="rIdFtr"/><w:pgSz w:w="${PAGE_W}" w:h="${PAGE_H}"${landscape ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN + 200}" w:left="${MARGIN}" w:header="360" w:footer="360" w:gutter="0"/><w:bidi/></w:sectPr>`;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}${sect}</w:body></w:document>`;
  const footer = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${NS}><w:p><w:pPr><w:bidi/><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t>1</w:t></w:r><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:eastAsia="${FONT}" w:cs="${FONT}"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="fa-IR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:bidi/><w:spacing w:after="80" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`;
  const exts = new Set(media.map(m => m.name.split('.').pop()));
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${exts.has('png') ? '<Default Extension="png" ContentType="image/png"/>' : ''}${exts.has('jpeg') ? '<Default Extension="jpeg" ContentType="image/jpeg"/>' : ''}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdSty" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdFtr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>${media.map(m => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join('')}</Relationships>`;
  const iso = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(model.title || '')}</dc:title><dc:creator>${esc(model.creator || 'Education Center Manager')}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified></cp:coreProperties>`;
  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Education Center Manager</Application></Properties>`;
  return zip([{ name: '[Content_Types].xml', data: ct }, { name: '_rels/.rels', data: rels }, { name: 'word/document.xml', data: document }, { name: 'word/styles.xml', data: styles }, { name: 'word/footer1.xml', data: footer }, { name: 'word/_rels/document.xml.rels', data: docRels }, { name: 'docProps/core.xml', data: core }, { name: 'docProps/app.xml', data: app }, ...media.map(m => ({ name: 'word/media/' + m.name, data: m.buf }))]);
}

/* ---------------- XLSX ---------------- */
const colName = (i) => { let n = i + 1, s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - m) / 26); } return s; };
function sheetNameOf(t) { const s = String(t || 'Sheet1').replace(/[\[\]:*?\/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31); return s || 'Sheet1'; }

function buildXlsx(model) {
  validateModel(model);
  const cur = model.currency || ''; const rows = [], merges = []; const units = []; let ncolsMax = 1;
  model.blocks.forEach(b => { if (b.t === 'table') ncolsMax = Math.max(ncolsMax, ...b.rows.map(r => r.cells.reduce((n, c) => n + (c.colspan || 1), 0))); });
  const widths = []; const setW = (ci, len) => { widths[ci] = Math.max(widths[ci] || 8, Math.min(60, len + 3)); };
  let firstHeaderRow = -1, headerCols = 0, titleDone = false;
  const pushText = (text, kind) => { const r = rows.length; rows.push([{ s: String(text), st: kind }]); if (ncolsMax > 1) merges.push(`A${r + 1}:${colName(ncolsMax - 1)}${r + 1}`); };
  model.blocks.forEach(b => {
    if (b.t === 'p') { const text = (b.runs || []).map(r => r.text || '').join('').replace(/\s+/g, ' ').trim(); if (!text) return; pushText(text, !titleDone ? 'title' : (b.b || b.heading) ? 'sub' : 'note'); titleDone = true; }
    else if (b.t === 'table') {
      if (rows.length) rows.push([]);
      b.rows.forEach((r, ri) => {
        const isHead = r.header === true || (b.header && ri === 0 && r.header !== false); const row = []; let ci = 0;
        r.cells.forEach(c => {
          const span = c.colspan || 1, txt = textOf(cellBlocks(c)).replace(/[ \t]+/g, ' ').trim();
          const num = !isHead && span === 1 ? parseNumber(txt, cur) : null;
          if (num) { row[ci] = { n: num.n, unit: num.unit, st: 'num' }; if (num.unit && !units.includes(num.unit)) units.push(num.unit); } else row[ci] = { s: txt, st: isHead ? 'head' : 'body' };
          for (let k = 1; k < span; k++) row[ci + k] = { s: '', st: isHead ? 'head' : 'body' };
          if (span > 1) merges.push(`${colName(ci)}${rows.length + 1}:${colName(ci + span - 1)}${rows.length + 1}`);
          if (span === 1) setW(ci, num ? String(num.n).length + 2 : Math.max(...txt.split('\n').map(l => l.length), 0));
          ci += span;
        });
        if (isHead && firstHeaderRow < 0) { firstHeaderRow = rows.length; headerCols = row.length; }
        rows.push(row);
      });
    }
  });
  const nCols = Math.max(1, ...rows.map(r => r.length));
  const unitFmtId = (u) => 164 + units.indexOf(u);
  // styles: 0 default,1 head,2 body,3 num,4 title,5 sub,6 note, 7+ numeric-with-unit
  const numFmts = units.map((u, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc('#,##0.##" ' + u.replace(/"/g, '') + '"')}"/>`).join('');
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1" readingOrder="2"/></xf>',
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1" readingOrder="2"/></xf>',
    '<xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" horizontal="right"/></xf>',
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center" readingOrder="2"/></xf>',
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" readingOrder="2"/></xf>',
    '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" readingOrder="2"/></xf>']
    .concat(units.map((u, i) => `<xf numFmtId="${164 + i}" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" horizontal="right"/></xf>`));
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmts ? `<numFmts count="${units.length}">${numFmts}</numFmts>` : ''}<fonts count="4"><font><sz val="11"/><name val="${FONT}"/><family val="2"/></font><font><b/><sz val="11"/><name val="${FONT}"/><family val="2"/></font><font><b/><sz val="15"/><name val="${FONT}"/><family val="2"/></font><font><sz val="10"/><color rgb="FF555555"/><name val="${FONT}"/><family val="2"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEEF1F6"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF888888"/></left><right style="thin"><color rgb="FF888888"/></right><top style="thin"><color rgb="FF888888"/></top><bottom style="thin"><color rgb="FF888888"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const ST = { head: 1, body: 2, num: 3, title: 4, sub: 5, note: 6 };
  const sheetRows = rows.map((r, ri) => { if (!r.length) return ''; const cells = []; for (let ci = 0; ci < r.length; ci++) { const c = r[ci]; if (!c) continue; const ref = colName(ci) + (ri + 1);
    if (c.n !== undefined) cells.push(`<c r="${ref}" s="${c.unit ? 7 + units.indexOf(c.unit) : ST.num}"><v>${c.n}</v></c>`); else cells.push(`<c r="${ref}" s="${ST[c.st] || 2}" t="inlineStr"><is><t xml:space="preserve">${esc(c.s)}</t></is></c>`); }
    const ht = r[0] && r[0].st === 'title' ? ' ht="26" customHeight="1"' : ''; return `<row r="${ri + 1}"${ht}>${cells.join('')}</row>`; }).join('');
  const cols = []; for (let i = 0; i < nCols; i++) cols.push(`<col min="${i + 1}" max="${i + 1}" width="${widths[i] || 12}" customWidth="1"/>`);
  const landscape = model.landscape === true || (model.landscape !== false && nCols >= 5);
  const pane = firstHeaderRow >= 0 ? `<pane ySplit="${firstHeaderRow + 1}" topLeftCell="A${firstHeaderRow + 2}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/>` : '';
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${colName(nCols - 1)}${Math.max(1, rows.length)}"/><sheetViews><sheetView rightToLeft="1" workbookViewId="0" tabSelected="1">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="16"/><cols>${cols.join('')}</cols><sheetData>${sheetRows}</sheetData>${firstHeaderRow >= 0 && rows.length > firstHeaderRow + 1 ? `<autoFilter ref="A${firstHeaderRow + 1}:${colName(Math.max(0, headerCols - 1))}${rows.length}"/>` : ''}${merges.length ? `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : ''}<printOptions horizontalCentered="1"/><pageMargins left="0.4" right="0.4" top="0.5" bottom="0.6" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="${landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/><headerFooter><oddFooter>&amp;C&amp;P / &amp;N</oddFooter></headerFooter></worksheet>`;
  const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetNameOf(model.title))}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  return zip([{ name: '[Content_Types].xml', data: ct }, { name: '_rels/.rels', data: rels }, { name: 'xl/workbook.xml', data: wb }, { name: 'xl/_rels/workbook.xml.rels', data: wbRels }, { name: 'xl/styles.xml', data: styles }, { name: 'xl/worksheets/sheet1.xml', data: sheet }]);
}

/* ---------------- انتخاب خودکار قالب + ذخیره ---------------- */
const safeName = (s) => String(s || 'document').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'document';
function stamp(d) { const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
function exportDocument({ kind, title, model, dir, name }) {
  const k = chooseKind(model, kind), buf = k === 'xlsx' ? buildXlsx(Object.assign({ title }, model)) : buildDocx(Object.assign({ title }, model));
  fs.mkdirSync(dir, { recursive: true });
  const base = safeName(name || title) + '-' + stamp(new Date()); let file = path.join(dir, base + '.' + k), i = 1;
  while (fs.existsSync(file)) file = path.join(dir, base + '-' + (++i) + '.' + k);
  fs.writeFileSync(file, buf);
  return { path: file, size: buf.length, kind: k, app: k === 'xlsx' ? 'Excel' : 'Word' };
}
// ذخیره‌ی فایل‌های خروجی دیگر (تصویر PNG، CSV، صفحه‌ی وب HTML) در همان پوشه‌ی خروجی‌ها
const SAVE_EXT = { png: 'base64', csv: 'text', html: 'text', txt: 'text' };
function saveFiles({ files, dir, name }) {
  if (!Array.isArray(files) || !files.length || files.length > 60) throw new Error('فایل‌های خروجی نامعتبر است.');
  fs.mkdirSync(dir, { recursive: true });
  const base = safeName(name || 'document') + '-' + stamp(new Date()), multi = files.length > 1, paths = []; let total = 0;
  files.forEach((f, i) => {
    const kind = SAVE_EXT[f && f.ext]; if (!kind) throw new Error('نوع فایل مجاز نیست.');
    let buf; if (kind === 'base64') { const m = /^(?:data:image\/png;base64,)?([A-Za-z0-9+/=\s]+)$/.exec(String(f.data || '')); if (!m) throw new Error('تصویر نامعتبر است.'); buf = Buffer.from(m[1].replace(/\s+/g, ''), 'base64'); if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('تصویر PNG نامعتبر است.'); }
    else { const text = String(f.text === undefined ? '' : f.text); buf = Buffer.concat([f.ext === 'csv' || f.ext === 'html' ? Buffer.from('\uFEFF', 'utf8') : Buffer.alloc(0), Buffer.from(text, 'utf8')]); }
    total += buf.length; if (total > 150 * 1024 * 1024) throw new Error('حجم خروجی بسیار زیاد است.');
    let file = path.join(dir, base + (multi ? '-' + (i + 1) : '') + '.' + f.ext), k = 1; while (fs.existsSync(file)) file = path.join(dir, base + (multi ? '-' + (i + 1) : '') + '-' + (++k) + '.' + f.ext);
    fs.writeFileSync(file, buf); paths.push(file);
  });
  return { paths, dir, size: total, count: paths.length };
}
module.exports = { saveFiles, zip, crc32, buildDocx, buildXlsx, chooseKind, exportDocument, parseNumber, imageSize, safeName };
