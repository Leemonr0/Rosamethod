/* ============================================================================
   ROSE MP4 Binary Patcher v3.0 (Client-side implementation)
   3 Optimized Bypass Modes:
     1. "safe"  (Rose Safe Pass · Recommended 2026): 100% clean video stream,
                0 NAL decode errors, mvhd 0xFFFFFFFFFFFFFFFF sentinel, 8B free box.
     2. "ghost" (Rose Ultra · CompressBase v4 Ghost): 12x ghost samples in stsz,
                exact 2026 CB udta (no Lavf), preserved camera timecodes, Zilem tail.
     3. "haze"  (Rose Haze Lite · 0x0 Stsd Clear): clears declared stsd frame size,
                mvhd unknown duration sentinel, Haze tag.
   100% Client-side. No server required. 0% quality loss.
   ============================================================================ */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RosePatcher = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts']);

  // Updated 2026 CompressBase udta meta body (171 bytes without Lavf61)
  const CB_2026_META_BOX = new Uint8Array([
    0x00,0x00,0x00,0xab,0x6d,0x65,0x74,0x61,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x21,
    0x68,0x64,0x6c,0x72,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x6d,0x64,0x69,0x72,
    0x61,0x70,0x70,0x6c,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
    0x7e,0x69,0x6c,0x73,0x74,0x00,0x00,0x00,0x47,0xa9,0x74,0x6f,0x6f,0x00,0x00,0x00,
    0x3f,0x64,0x61,0x74,0x61,0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x00,0x5a,0x69,0x6c,
    0x65,0x6d,0x20,0x4d,0x65,0x74,0x68,0x6f,0x64,0x20,0x68,0x74,0x74,0x70,0x73,0x3a,
    0x2f,0x2f,0x7a,0x69,0x6c,0x65,0x6d,0x6d,0x65,0x74,0x68,0x6f,0x64,0x2e,0x63,0x6f,
    0x6d,0x20,0x6c,0x6f,0x63,0x61,0x6c,0x3a,0x76,0x35,0x2e,0x30,0x00,0x00,0x00,0x2f,
    0xa9,0x63,0x6d,0x74,0x00,0x00,0x00,0x27,0x64,0x61,0x74,0x61,0x00,0x00,0x00,0x01,
    0x00,0x00,0x00,0x00,0x50,0x61,0x74,0x63,0x68,0x65,0x64,0x20,0x62,0x79,0x20,0x43,
    0x6f,0x6d,0x70,0x72,0x65,0x73,0x73,0x62,0x61,0x73,0x65
  ]);

  // Exact 256-byte ghost payload
  const GHOST_PAYLOAD_256 = new Uint8Array(256);
  GHOST_PAYLOAD_256[0] = 0x00;
  GHOST_PAYLOAD_256[1] = 0x00;
  GHOST_PAYLOAD_256[2] = 0x00;
  GHOST_PAYLOAD_256[3] = 0xfc;

  // Exact 8-byte free box
  const FREE_BOX_8 = new Uint8Array([0x00, 0x00, 0x00, 0x08, 0x66, 0x72, 0x65, 0x65]);

  function u32(val) {
    const b = new Uint8Array(4);
    b[0] = (val >>> 24) & 0xff;
    b[1] = (val >>> 16) & 0xff;
    b[2] = (val >>> 8) & 0xff;
    b[3] = val & 0xff;
    return b;
  }

  function u64(val) {
    const b = new Uint8Array(8);
    const big = BigInt(val);
    const hi = Number(big >> 32n);
    const lo = Number(big & 0xffffffffn);
    b.set(u32(hi), 0);
    b.set(u32(lo), 4);
    return b;
  }

  function r32(bytes, offset) {
    return (
      ((bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3]) >>>
      0
    );
  }

  function r64(bytes, offset) {
    const hi = BigInt(r32(bytes, offset));
    const lo = BigInt(r32(bytes, offset + 4));
    return Number((hi << 32n) | lo);
  }

  function concatArrays(arrs) {
    let totalLen = 0;
    for (const a of arrs) totalLen += a.length;
    const out = new Uint8Array(totalLen);
    let pos = 0;
    for (const a of arrs) {
      out.set(a, pos);
      pos += a.length;
    }
    return out;
  }

  function strToBytes(str) {
    const b = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) b[i] = str.charCodeAt(i) & 0xff;
    return b;
  }

  function bytesToStr(bytes) {
    return String.fromCharCode.apply(null, bytes);
  }

  class Mp4Node {
    constructor(type, payload = null, children = null) {
      this.type = type;
      this.payload = payload || new Uint8Array(0);
      this.children = children;
    }

    find(type) {
      if (!this.children) return null;
      for (const c of this.children) {
        if (c.type === type) return c;
      }
      return null;
    }

    findAll(type) {
      if (!this.children) return [];
      return this.children.filter((c) => c.type === type);
    }

    path(...types) {
      let cur = this;
      for (const t of types) {
        cur = cur ? cur.find(t) : null;
        if (!cur) return null;
      }
      return cur;
    }

    serialize() {
      const body = this.children
        ? concatArrays(this.children.map((c) => c.serialize()))
        : this.payload;
      const typeBytes = strToBytes(this.type);
      if (body.length + 8 > 0xffffffff) {
        return concatArrays([u32(1), typeBytes, u64(body.length + 16), body]);
      }
      return concatArrays([u32(body.length + 8), typeBytes, body]);
    }
  }

  function parseBoxChildren(data, start, end) {
    const nodes = [];
    let pos = start;
    while (pos + 8 <= end) {
      let sz = r32(data, pos);
      let hdrLen = 8;
      if (sz === 1) {
        if (pos + 16 > end) break;
        sz = r64(data, pos + 8);
        hdrLen = 16;
      } else if (sz === 0) {
        sz = end - pos;
      }
      if (sz < hdrLen || pos + sz > end) break;
      const type = bytesToStr(data.subarray(pos + 4, pos + 8));
      if (CONTAINER_BOXES.has(type)) {
        nodes.push(new Mp4Node(type, null, parseBoxChildren(data, pos + hdrLen, pos + sz)));
      } else {
        nodes.push(new Mp4Node(type, data.subarray(pos + hdrLen, pos + sz)));
      }
      pos += sz;
    }
    return nodes;
  }

  function inspectTopBoxes(data) {
    const boxes = [];
    let pos = 0;
    while (pos + 8 <= data.length) {
      let sz = r32(data, pos);
      let hdrLen = 8;
      if (sz === 1) {
        if (pos + 16 > data.length) break;
        sz = r64(data, pos + 8);
        hdrLen = 16;
      } else if (sz === 0) {
        sz = data.length - pos;
      }
      if (sz < hdrLen || pos + sz > data.length) break;
      const name = bytesToStr(data.subarray(pos + 4, pos + 8));
      boxes.push({ name, offset: pos, size: sz, headerLen: hdrLen });
      pos += sz;
    }
    return boxes;
  }

  function upgradeMvhd(payload) {
    if (payload.length < 4) throw new Error("Truncated mvhd");
    const ver = payload[0];
    const sentinel = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    if (ver === 1) {
      if (payload.length < 112) throw new Error("Short v1 mvhd");
      const out = new Uint8Array(payload);
      out.set(sentinel, 24);
      return out;
    }
    if (ver !== 0 || payload.length < 100) throw new Error("Unsupported mvhd ver " + ver);
    return concatArrays([
      new Uint8Array([1, payload[1], payload[2], payload[3]]),
      u32(0),
      payload.subarray(4, 8),
      u32(0),
      payload.subarray(8, 12),
      payload.subarray(12, 16),
      sentinel,
      payload.subarray(20, 100),
    ]);
  }

  function getOffsetBox(trak) {
    const stbl = trak.path("mdia", "minf", "stbl");
    if (!stbl) return null;
    return stbl.find("stco") || stbl.find("co64");
  }

  function readChunkOffsets(offsBox) {
    const pl = offsBox.payload;
    const cnt = r32(pl, 4);
    const isCo64 = offsBox.type === "co64";
    const res = [];
    for (let i = 0; i < cnt; i++) {
      res.push(isCo64 ? r64(pl, 8 + i * 8) : r32(pl, 8 + i * 4));
    }
    return res;
  }

  function writeChunkOffsets(offsBox, offsets) {
    let maxOff = 0;
    for (const o of offsets) if (o > maxOff) maxOff = o;
    if (maxOff > 0xffffffff) {
      offsBox.type = "co64";
      const body = [new Uint8Array(4), u32(offsets.length)];
      for (const o of offsets) body.push(u64(o));
      offsBox.payload = concatArrays(body);
    } else {
      offsBox.type = "stco";
      const body = [new Uint8Array(4), u32(offsets.length)];
      for (const o of offsets) body.push(u32(o));
      offsBox.payload = concatArrays(body);
    }
  }

  function isAlreadyPatched(data) {
    try {
      const top = inspectTopBoxes(data);
      for (const b of top) {
        if (b.name === "free") {
          const body = data.subarray(b.offset + b.headerLen, b.offset + Math.min(b.size, b.headerLen + 80));
          if (bytesToStr(body).indexOf("ZILEM_OPTIMIZED/1") !== -1) return true;
        } else if (b.name === "moov") {
          const body = data.subarray(b.offset + b.headerLen, b.offset + b.size);
          const nodes = parseBoxChildren(body, 0, body.length);
          const moov = new Mp4Node("moov", null, nodes);
          const mvhd = moov.find("mvhd");
          if (mvhd && mvhd.payload.length >= 32 && mvhd.payload[0] === 1) {
            let ok = true;
            for (let i = 0; i < 8; i++) {
              if (mvhd.payload[24 + i] !== 0xff) {
                ok = false;
                break;
              }
            }
            if (ok) return true;
          }
        }
      }
    } catch (_) {}
    return false;
  }

  /* --------------------------------------------------------------------------
     MODE 1: patchSafe (Variant-1 / Clean Sentinel Pass) - RECOMMENDED 2026
     - 0 decoder errors, 100% video stream copy
     - mvhd v1 unknown duration sentinel
     - Updated 2026 CompressBase udta (preserves existing camera tags)
     - 8B free box
     - Shifted stco offsets
     -------------------------------------------------------------------------- */
  function patchSafe(data) {
    const topBoxes = inspectTopBoxes(data);
    const moovInfo = topBoxes.find((b) => b.name === "moov");
    const mdatInfo = topBoxes.find((b) => b.name === "mdat");
    if (!moovInfo || !mdatInfo) {
      throw new Error("Missing moov or mdat box.");
    }

    const moovChildren = parseBoxChildren(
      data,
      moovInfo.offset + moovInfo.headerLen,
      moovInfo.offset + moovInfo.size
    );
    const moov = new Mp4Node("moov", null, moovChildren);

    // 1. Upgrade mvhd
    const mvhd = moov.find("mvhd");
    if (!mvhd) throw new Error("Missing mvhd box.");
    mvhd.payload = upgradeMvhd(mvhd.payload);

    // 2. Update udta: keep existing tags, add updated 2026 meta
    const udta = moov.find("udta");
    if (udta) {
      const udtaChildren = parseBoxChildren(udta.payload, 0, udta.payload.length);
      const nonMeta = udtaChildren.filter((c) => c.type !== "meta");
      const parts = nonMeta.map((c) => c.serialize());
      parts.push(CB_2026_META_BOX);
      udta.payload = concatArrays(parts);
    } else {
      moov.children.push(new Mp4Node("udta", CB_2026_META_BOX));
    }

    // 3. Read chunk offsets
    const traks = moov.findAll("trak");
    const trakOffsetsList = [];
    for (const t of traks) {
      const ob = getOffsetBox(t);
      if (ob) trakOffsetsList.push({ trak: t, ob, offsets: readChunkOffsets(ob) });
    }

    const oldMoovSize = moovInfo.size;
    const moovBeforeMdat = moovInfo.offset < mdatInfo.offset;

    // 4. Compute shift delta (including 8-byte inserted free box)
    for (let iter = 0; iter < 4; iter++) {
      const curMoovSize = moov.serialize().length;
      const delta = moovBeforeMdat ? (curMoovSize - oldMoovSize + 8) : 0;
      for (const item of trakOffsetsList) {
        const shifted = item.offsets.map((o) => o + delta);
        writeChunkOffsets(item.ob, shifted);
      }
    }

    const newMoovBytes = moov.serialize();

    // 5. Assemble output
    const outParts = [];
    for (const b of topBoxes) {
      if (b.name === "moov") {
        outParts.push(newMoovBytes);
        if (moovBeforeMdat) {
          outParts.push(FREE_BOX_8);
        }
      } else {
        outParts.push(data.subarray(b.offset, b.offset + b.size));
      }
    }

    return concatArrays(outParts);
  }

  /* --------------------------------------------------------------------------
     MODE 2: patchGhost (Variant-2 / CompressBase 2026 Ghost v4)
     - 12x ghost sample inflation in stsz
     - 256-byte ghost payload in mdat
     - Updated 2026 CB udta tag (no Lavf)
     - Preserves original camera tags
     - Fixed Zilem free tail
     -------------------------------------------------------------------------- */
  function patchGhost(data, ghostMultiplier = 12) {
    const topBoxes = inspectTopBoxes(data);
    const moovInfo = topBoxes.find((b) => b.name === "moov");
    const mdatInfo = topBoxes.find((b) => b.name === "mdat");
    if (!moovInfo || !mdatInfo) throw new Error("Missing moov or mdat.");

    const moovChildren = parseBoxChildren(
      data,
      moovInfo.offset + moovInfo.headerLen,
      moovInfo.offset + moovInfo.size
    );
    const moov = new Mp4Node("moov", null, moovChildren);

    // 1. Upgrade mvhd sentinel
    const mvhd = moov.find("mvhd");
    if (!mvhd) throw new Error("Missing mvhd.");
    mvhd.payload = upgradeMvhd(mvhd.payload);

    // 2. Locate video track
    const traks = moov.findAll("trak");
    let videTrak = null;
    for (const t of traks) {
      const hdlr = t.path("mdia", "hdlr");
      if (hdlr && hdlr.payload.length >= 12) {
        if (bytesToStr(hdlr.payload.subarray(8, 12)) === "vide") {
          videTrak = t;
          break;
        }
      }
    }
    if (!videTrak) throw new Error("Missing video track.");

    const stbl = videTrak.path("mdia", "minf", "stbl");
    const stsz = stbl ? stbl.find("stsz") : null;
    const stts = stbl ? stbl.find("stts") : null;
    const stsc = stbl ? stbl.find("stsc") : null;
    const videOffsBox = getOffsetBox(videTrak);
    if (!stsz || !stts || !stsc || !videOffsBox) throw new Error("Missing sample tables.");

    // 3. Patch stsz
    const constSampleSize = r32(stsz.payload, 4);
    const origSampleCount = r32(stsz.payload, 8);
    const origSizes = [];
    if (constSampleSize === 0) {
      for (let i = 0; i < origSampleCount; i++) origSizes.push(r32(stsz.payload, 12 + i * 4));
    } else {
      for (let i = 0; i < origSampleCount; i++) origSizes.push(constSampleSize);
    }
    const ghostCount = origSampleCount * ghostMultiplier;
    const newSizes = origSizes.concat(new Array(ghostCount).fill(256));
    const stszBody = [stsz.payload.subarray(0, 4), u32(0), u32(newSizes.length)];
    for (const s of newSizes) stszBody.push(u32(s));
    stsz.payload = concatArrays(stszBody);

    // 4. Patch stts
    const sttsCnt = r32(stts.payload, 4);
    const sttsEntries = [];
    for (let i = 0; i < sttsCnt; i++) {
      sttsEntries.push([r32(stts.payload, 8 + i * 8), r32(stts.payload, 12 + i * 8)]);
    }
    if (sttsEntries.length > 0 && sttsEntries[sttsEntries.length - 1][0] > 1) {
      sttsEntries[sttsEntries.length - 1][0] -= 1;
      sttsEntries.push([1, 0]);
    }
    const sttsBody = [stts.payload.subarray(0, 4), u32(sttsEntries.length)];
    for (const [c, d] of sttsEntries) {
      sttsBody.push(u32(c));
      sttsBody.push(u32(d));
    }
    stts.payload = concatArrays(sttsBody);

    // 5. Patch stsc
    const origVideOffsets = readChunkOffsets(videOffsBox);
    const origChunkCount = origVideOffsets.length;
    const stscCnt = r32(stsc.payload, 4);
    const stscEntries = [];
    for (let i = 0; i < stscCnt; i++) {
      stscEntries.push([
        r32(stsc.payload, 8 + i * 12),
        r32(stsc.payload, 12 + i * 12),
        r32(stsc.payload, 16 + i * 12),
      ]);
    }
    stscEntries.push([origChunkCount + 1, 1, 1]);
    const stscBody = [stsc.payload.subarray(0, 4), u32(stscEntries.length)];
    for (const [a, b, c] of stscEntries) {
      stscBody.push(u32(a));
      stscBody.push(u32(b));
      stscBody.push(u32(c));
    }
    stsc.payload = concatArrays(stscBody);

    // 6. Update udta: keep existing tags (e.g. timecode), append updated 2026 meta
    const udta = moov.find("udta");
    if (udta) {
      const udtaChildren = parseBoxChildren(udta.payload, 0, udta.payload.length);
      const nonMeta = udtaChildren.filter((c) => c.type !== "meta");
      const parts = nonMeta.map((c) => c.serialize());
      parts.push(CB_2026_META_BOX);
      udta.payload = concatArrays(parts);
    } else {
      moov.children.push(new Mp4Node("udta", CB_2026_META_BOX));
    }

    // 7. Calculate offset shifts
    const trakOffsetsList = [];
    for (const t of traks) {
      const ob = getOffsetBox(t);
      if (ob) trakOffsetsList.push({ trak: t, ob, offsets: readChunkOffsets(ob) });
    }

    for (const item of trakOffsetsList) {
      if (item.trak === videTrak) {
        writeChunkOffsets(item.ob, item.offsets.concat(new Array(ghostCount).fill(0)));
      } else {
        writeChunkOffsets(item.ob, item.offsets);
      }
    }

    const oldMoovSize = moovInfo.size;
    const moovBeforeMdat = moovInfo.offset < mdatInfo.offset;

    for (let iter = 0; iter < 4; iter++) {
      const curMoovSize = moov.serialize().length;
      const delta = moovBeforeMdat ? curMoovSize - oldMoovSize : 0;
      const ghostFileOffset = mdatInfo.offset + delta + mdatInfo.size;
      for (const item of trakOffsetsList) {
        const shifted = item.offsets.map((o) => o + delta);
        if (item.trak === videTrak) {
          for (let g = 0; g < ghostCount; g++) shifted.push(ghostFileOffset);
        }
        writeChunkOffsets(item.ob, shifted);
      }
    }

    const newMoovBytes = moov.serialize();

    // 8. Assemble output
    const outParts = [];
    for (const b of topBoxes) {
      if (b.name === "moov") {
        outParts.push(newMoovBytes);
      } else if (b.name === "mdat") {
        const newMdatSize = b.size + GHOST_PAYLOAD_256.length;
        if (b.headerLen === 16 || newMdatSize > 0xffffffff) {
          outParts.push(concatArrays([u32(1), strToBytes("mdat"), u64(newMdatSize + (b.headerLen === 16 ? 0 : 8))]));
        } else {
          outParts.push(concatArrays([u32(newMdatSize), strToBytes("mdat")]));
        }
        outParts.push(data.subarray(b.offset + b.headerLen, b.offset + b.size));
        outParts.push(GHOST_PAYLOAD_256);
      } else {
        outParts.push(data.subarray(b.offset, b.offset + b.size));
      }
    }

    // Exact 2026 Zilem tail
    const tailStr = "ZILEM_OPTIMIZED/1 2026-10-03T03:46:48.570Z 1001 (2)_zilem.mp4";
    const tailBytes = strToBytes(tailStr);
    const tailBox = concatArrays([u32(tailBytes.length + 8), strToBytes("free"), tailBytes]);
    outParts.push(tailBox);

    return concatArrays(outParts);
  }

  /* --------------------------------------------------------------------------
     MODE 3: patchHaze (Haze Lite · 0x0 Stsd Clear)
     - Clears declared frame size in stsd to 0x0
     - mvhd v1 unknown duration sentinel
     - Haze Quality Method udta
     -------------------------------------------------------------------------- */
  function patchHaze(data) {
    const topBoxes = inspectTopBoxes(data);
    const moovInfo = topBoxes.find((b) => b.name === "moov");
    const mdatInfo = topBoxes.find((b) => b.name === "mdat");
    if (!moovInfo || !mdatInfo) throw new Error("Missing moov or mdat.");

    const moovChildren = parseBoxChildren(
      data,
      moovInfo.offset + moovInfo.headerLen,
      moovInfo.offset + moovInfo.size
    );
    const moov = new Mp4Node("moov", null, moovChildren);

    // 1. Upgrade mvhd
    const mvhd = moov.find("mvhd");
    if (!mvhd) throw new Error("Missing mvhd.");
    mvhd.payload = upgradeMvhd(mvhd.payload);

    // 2. Clear declared frame size in video stsd
    const traks = moov.findAll("trak");
    for (const t of traks) {
      const hdlr = t.path("mdia", "hdlr");
      if (hdlr && hdlr.payload.length >= 12 && bytesToStr(hdlr.payload.subarray(8, 12)) === "vide") {
        const stsd = t.path("mdia", "minf", "stbl", "stsd");
        if (stsd && stsd.payload.length >= 44) {
          const pl = new Uint8Array(stsd.payload);
          pl.fill(0, 40, 44);
          stsd.payload = pl;
        }
      }
    }

    // 3. Add Haze tag
    const hazeTag = strToBytes("Haze Quality Method https://hazemethod.xyz");
    const dataAtom = concatArrays([u32(hazeTag.length + 16), strToBytes("data"), u32(1), u32(0), hazeTag]);
    const tooAtom = concatArrays([u32(dataAtom.length + 8), strToBytes("\xa9too"), dataAtom]);
    const ilstAtom = concatArrays([u32(tooAtom.length + 8), strToBytes("ilst"), tooAtom]);
    const hdlrAtom = concatArrays([u32(33), strToBytes("hdlr"), u32(0), u32(0), strToBytes("mdirappl"), new Uint8Array(9)]);
    const metaBody = concatArrays([u32(0), hdlrAtom, ilstAtom]);
    const metaAtom = concatArrays([u32(metaBody.length + 8), strToBytes("meta"), metaBody]);

    const udta = moov.find("udta");
    if (udta) {
      const udtaChildren = parseBoxChildren(udta.payload, 0, udta.payload.length);
      const nonMeta = udtaChildren.filter((c) => c.type !== "meta");
      const parts = nonMeta.map((c) => c.serialize());
      parts.push(metaAtom);
      udta.payload = concatArrays(parts);
    } else {
      moov.children.push(new Mp4Node("udta", metaAtom));
    }

    // 4. Offset shifts
    const trakOffsetsList = [];
    for (const t of traks) {
      const ob = getOffsetBox(t);
      if (ob) trakOffsetsList.push({ trak: t, ob, offsets: readChunkOffsets(ob) });
    }

    const oldMoovSize = moovInfo.size;
    const moovBeforeMdat = moovInfo.offset < mdatInfo.offset;

    for (let iter = 0; iter < 4; iter++) {
      const curMoovSize = moov.serialize().length;
      const delta = moovBeforeMdat ? curMoovSize - oldMoovSize : 0;
      for (const item of trakOffsetsList) {
        const shifted = item.offsets.map((o) => o + delta);
        writeChunkOffsets(item.ob, shifted);
      }
    }

    const newMoovBytes = moov.serialize();

    const outParts = [];
    for (const b of topBoxes) {
      if (b.name === "moov") {
        outParts.push(newMoovBytes);
      } else {
        outParts.push(data.subarray(b.offset, b.offset + b.size));
      }
    }

    return concatArrays(outParts);
  }

  // Unified dispatcher
  function patch(data, mode = "safe") {
    if (isAlreadyPatched(data)) {
      return data;
    }
    if (mode === "ghost" || mode === "ultra") {
      return patchGhost(data, 12);
    }
    if (mode === "haze") {
      return patchHaze(data);
    }
    return patchSafe(data);
  }

  return {
    patch: patch,
    patchSafe: patchSafe,
    patchGhost: patchGhost,
    patchHaze: patchHaze,
    isAlreadyPatched: isAlreadyPatched,
  };
}));
