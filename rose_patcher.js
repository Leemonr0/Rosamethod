/**
 * Rosa Pro — Browser MP4 Container Bypass Engine (1080p 120 FPS)
 * Implements the 0x0 stsd clear + Audio Track 3 sample inflation algorithm
 * with strict FastStart container assembly and Rosa Pro metadata.
 */
(function (root, factory) {
  if (typeof define === "function" && define.amd) {
    define([], factory);
  } else if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.RosePatcher = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STANDARD_FTYP_32 = new Uint8Array([
    0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, // size 32, 'ftyp'
    0x69, 0x73, 0x6f, 0x6d,                         // major brand 'isom'
    0x00, 0x00, 0x02, 0x00,                         // minor version
    0x69, 0x73, 0x6f, 0x6d,                         // compatible 'isom'
    0x69, 0x73, 0x6f, 0x32,                         // compatible 'iso2'
    0x61, 0x76, 0x63, 0x31,                         // compatible 'avc1'
    0x6d, 0x70, 0x34, 0x31                          // compatible 'mp41'
  ]);

  const FREE_BOX_8 = new Uint8Array([0x00, 0x00, 0x00, 0x08, 0x66, 0x72, 0x65, 0x65]);
  const DUMMY_AAC_8 = new Uint8Array([0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00]);
  const DUMMY_COUNT = 4194;
  const JUNK_TAIL_SIZE = 4 * 1024 * 1024; // 4MB Haze Junk Tail padding

  const ROSA_TAG_TEXT = "Rosa Quality Method https://leemonr0.github.io/Rosamethod/ | Rosa Pro";

  function strToBytes(str) {
    const arr = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i);
    return arr;
  }

  function bytesToStr(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function u32(val) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, val >>> 0, false);
    return b;
  }

  function u64(val) {
    const b = new Uint8Array(8);
    const view = new DataView(b.buffer);
    if (typeof val === "bigint") {
      view.setBigUint64(0, val, false);
    } else {
      view.setBigUint64(0, BigInt(val), false);
    }
    return b;
  }

  function r32(arr, offset) {
    return new DataView(arr.buffer, arr.byteOffset + offset, 4).getUint32(0, false);
  }

  function concatArrays(arrays) {
    let totalLen = 0;
    for (let i = 0; i < arrays.length; i++) totalLen += arrays[i].length;
    const res = new Uint8Array(totalLen);
    let off = 0;
    for (let i = 0; i < arrays.length; i++) {
      res.set(arrays[i], off);
      off += arrays[i].length;
    }
    return res;
  }

  function buildRosaUdta() {
    const tagBytes = strToBytes(ROSA_TAG_TEXT);
    const dataAtom = concatArrays([u32(tagBytes.length + 16), strToBytes("data"), u32(1), u32(0), tagBytes]);
    const tooAtom = concatArrays([u32(dataAtom.length + 8), new Uint8Array([0xa9, 0x74, 0x6f, 0x6f]), dataAtom]);
    const ilstAtom = concatArrays([u32(tooAtom.length + 8), strToBytes("ilst"), tooAtom]);
    const hdlrAtom = concatArrays([u32(33), strToBytes("hdlr"), u32(0), u32(0), strToBytes("mdir"), new Uint8Array(13)]);
    const metaAtom = concatArrays([u32(hdlrAtom.length + ilstAtom.length + 12), strToBytes("meta"), u32(0), hdlrAtom, ilstAtom]);
    return concatArrays([u32(metaAtom.length + 8), strToBytes("udta"), metaAtom]);
  }

  function inspectTopBoxes(data) {
    const boxes = [];
    let pos = 0;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    while (pos + 8 <= data.length) {
      let sz = view.getUint32(pos, false);
      let hdr = 8;
      if (sz === 1) {
        if (pos + 16 > data.length) break;
        const hi = view.getUint32(pos + 8, false);
        const lo = view.getUint32(pos + 12, false);
        sz = hi * 4294967296 + lo;
        hdr = 16;
      } else if (sz === 0) {
        sz = data.length - pos;
      }
      if (sz < hdr || pos + sz > data.length) break;
      const name = bytesToStr(data.subarray(pos + 4, pos + 8));
      boxes.append ? boxes.append({ name, offset: pos, size: sz, headerLen: hdr }) : boxes.push({ name, offset: pos, size: sz, headerLen: hdr });
      pos += sz;
    }
    return boxes;
  }

  class Mp4Node {
    constructor(type, payload = null, children = null) {
      this.type = type;
      this.payload = payload;
      this.children = children;
    }

    find(type) {
      if (!this.children) return null;
      return this.children.find((c) => c.type === type) || null;
    }

    findAll(type) {
      if (!this.children) return [];
      return this.children.filter((c) => c.type === type);
    }

    path(...types) {
      let curr = this;
      for (const t of types) {
        curr = curr.find(t);
        if (!curr) return null;
      }
      return curr;
    }

    serialize() {
      if (this.children !== null) {
        const parts = this.children.map((c) => c.serialize());
        const body = concatArrays(parts);
        return concatArrays([u32(body.length + 8), strToBytes(this.type), body]);
      } else {
        const body = this.payload || new Uint8Array(0);
        return concatArrays([u32(body.length + 8), strToBytes(this.type), body]);
      }
    }
  }

  const CONTAINER_TYPES = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "udta", "meta", "ilst"]);

  function parseBoxChildren(data, start, end) {
    const nodes = [];
    let pos = start;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    while (pos + 8 <= end) {
      let sz = view.getUint32(pos, false);
      let hdr = 8;
      if (sz === 1) {
        if (pos + 16 > end) break;
        const hi = view.getUint32(pos + 8, false);
        const lo = view.getUint32(pos + 12, false);
        sz = hi * 4294967296 + lo;
        hdr = 16;
      } else if (sz === 0) {
        sz = end - pos;
      }
      if (sz < hdr || pos + sz > end) break;
      const typ = bytesToStr(data.subarray(pos + 4, pos + 8));
      let contentStart = pos + hdr;
      let contentEnd = pos + sz;
      if (typ === "meta") contentStart += 4;

      if (CONTAINER_TYPES.has(typ)) {
        const children = parseBoxChildren(data, contentStart, contentEnd);
        nodes.push(new Mp4Node(typ, null, children));
      } else {
        nodes.push(new Mp4Node(typ, data.subarray(contentStart, contentEnd), null));
      }
      pos += sz;
    }
    return nodes;
  }

  function upgradeMvhd(mvhdPayload) {
    const ver = mvhdPayload[0];
    const flags = mvhdPayload.subarray(1, 4);
    const view = new DataView(mvhdPayload.buffer, mvhdPayload.byteOffset, mvhdPayload.byteLength);
    if (ver === 0) {
      const cTime = view.getUint32(4, false);
      const mTime = view.getUint32(8, false);
      const timescale = view.getUint32(12, false);
      const rest = mvhdPayload.subarray(20);
      return concatArrays([
        new Uint8Array([1]),
        flags,
        u64(cTime),
        u64(mTime),
        u32(timescale),
        u64(0xffffffffffffffffn),
        rest,
      ]);
    } else {
      const cTime = view.getBigUint64(4, false);
      const mTime = view.getBigUint64(12, false);
      const timescale = view.getUint32(20, false);
      const rest = mvhdPayload.subarray(32);
      return concatArrays([
        new Uint8Array([1]),
        flags,
        u64(cTime),
        u64(mTime),
        u32(timescale),
        u64(0xffffffffffffffffn),
        rest,
      ]);
    }
  }

  function getOffsetBox(trak) {
    const stbl = trak.path("mdia", "minf", "stbl");
    if (!stbl) return null;
    return stbl.find("stco") || stbl.find("co64");
  }

  function readChunkOffsets(box) {
    const view = new DataView(box.payload.buffer, box.payload.byteOffset, box.payload.byteLength);
    const count = view.getUint32(4, false);
    const offsets = [];
    if (box.type === "stco") {
      for (let i = 0; i < count; i++) offsets.push(view.getUint32(8 + i * 4, false));
    } else if (box.type === "co64") {
      for (let i = 0; i < count; i++) offsets.push(Number(view.getBigUint64(8 + i * 8, false)));
    }
    return offsets;
  }

  function writeChunkOffsets(box, offsets) {
    const needsCo64 = offsets.some((o) => o > 0xffffffff);
    if (needsCo64 || box.type === "co64") {
      box.type = "co64";
      const body = [u32(0), u32(offsets.length)];
      for (const o of offsets) body.push(u64(o));
      box.payload = concatArrays(body);
    } else {
      box.type = "stco";
      const body = [u32(0), u32(offsets.length)];
      for (const o of offsets) body.push(u32(o));
      box.payload = concatArrays(body);
    }
  }

  // =========================================================================
  // ROSA PRO ENGINE (FASTSTART + 0X0 STSD + AUDIO 10X GHOST)
  // =========================================================================
  function patchRosa(data) {
    const topBoxes = inspectTopBoxes(data);
    const moovInfo = topBoxes.find((b) => b.name === "moov");
    const mdatInfo = topBoxes.find((b) => b.name === "mdat");
    if (!moovInfo || !mdatInfo) throw new Error("Missing moov or mdat box.");

    const moovChildren = parseBoxChildren(
      data,
      moovInfo.offset + moovInfo.headerLen,
      moovInfo.offset + moovInfo.size
    );
    const moov = new Mp4Node("moov", null, moovChildren);

    // 1. Upgrade mvhd sentinel v1
    const mvhd = moov.find("mvhd");
    if (!mvhd) throw new Error("Missing mvhd box.");
    mvhd.payload = upgradeMvhd(mvhd.payload);

    // 2. Video track: zero out declared stsd dimensions (0x0 bypasses TikTok transcoding profile)
    const traks = moov.findAll("trak");
    let videTrak = null;
    let sounTrak = null;
    for (const t of traks) {
      const hdlr = t.path("mdia", "hdlr");
      if (hdlr && hdlr.payload.length >= 12) {
        const handler = bytesToStr(hdlr.payload.subarray(8, 12));
        if (handler === "vide") videTrak = t;
        if (handler === "soun" && !sounTrak) sounTrak = t;
      }
    }
    if (!videTrak) throw new Error("Missing video track.");

    const stsd = videTrak.path("mdia", "minf", "stbl", "stsd");
    if (stsd && stsd.payload.length >= 44) {
      stsd.payload[40] = 0; stsd.payload[41] = 0;
      stsd.payload[42] = 0; stsd.payload[43] = 0;
    }

    // 3. Audio track: clone as Track 3 with 10x sample inflation
    if (sounTrak) {
      const sounBytes = sounTrak.serialize();
      const sounCloneChildren = parseBoxChildren(sounBytes, 8, sounBytes.length);
      const trak3 = new Mp4Node("trak", null, sounCloneChildren);

      const tkhd3 = trak3.find("tkhd");
      if (tkhd3 && tkhd3.payload.length >= 20) {
        const ver = tkhd3.payload[0];
        const off = ver === 0 ? 12 : 16;
        tkhd3.payload.set(u32(3), off);
      }

      const stts3 = trak3.path("mdia", "minf", "stbl", "stts");
      if (stts3) {
        const cnt = r32(stts3.payload, 4);
        const entries = [];
        for (let i = 0; i < cnt; i++) {
          entries.push([r32(stts3.payload, 8 + i * 8), r32(stts3.payload, 12 + i * 8)]);
        }
        entries.push([DUMMY_COUNT, 1]);
        const b = [stts3.payload.subarray(0, 4), u32(entries.length)];
        for (const [c, d] of entries) { b.push(u32(c)); b.push(u32(d)); }
        stts3.payload = concatArrays(b);
      }

      const stsc3 = trak3.path("mdia", "minf", "stbl", "stsc");
      const ob3 = getOffsetBox(trak3);
      const origOffs3 = ob3 ? readChunkOffsets(ob3) : [];
      const lastChunkIdx = origOffs3.length;
      if (stsc3 && lastChunkIdx > 0) {
        const scCnt = r32(stsc3.payload, 4);
        const scEntries = [];
        for (let i = 0; i < scCnt; i++) {
          scEntries.push([
            r32(stsc3.payload, 8 + i * 12),
            r32(stsc3.payload, 12 + i * 12),
            r32(stsc3.payload, 16 + i * 12),
          ]);
        }
        scEntries.push([lastChunkIdx, 1 + DUMMY_COUNT, 1]);
        const b = [stsc3.payload.subarray(0, 4), u32(scEntries.length)];
        for (const [x, y, z] of scEntries) { b.push(u32(x)); b.push(u32(y)); b.push(u32(z)); }
        stsc3.payload = concatArrays(b);
      }

      const stsz3 = trak3.path("mdia", "minf", "stbl", "stsz");
      if (stsz3) {
        const sFixed = r32(stsz3.payload, 4);
        const sCnt = r32(stsz3.payload, 8);
        const sSizes = [];
        if (sFixed !== 0) {
          for (let i = 0; i < sCnt; i++) sSizes.push(sFixed);
        } else {
          for (let i = 0; i < sCnt; i++) sSizes.push(r32(stsz3.payload, 12 + i * 4));
        }
        for (let i = 0; i < DUMMY_COUNT; i++) sSizes.push(8);
        const b = [stsz3.payload.subarray(0, 4), u32(0), u32(sSizes.length)];
        for (const s of sSizes) b.push(u32(s));
        stsz3.payload = concatArrays(b);
      }

      moov.children.push(trak3);
    }

    // 4. Inject official Rosa UDTA
    const udta = moov.find("udta");
    if (udta) {
      moov.children = moov.children.filter((c) => c.type !== "udta");
    }
    const rosaUdtaBox = buildRosaUdta();
    moov.children.push(new Mp4Node("udta", rosaUdtaBox.subarray(8)));

    // 5. Shift all chunk offsets in strict FastStart layout [ftyp, moov (at 32B), free (8B), mdat]
    const allTraks = moov.findAll("trak");
    const trakOffsetsList = [];
    for (const t of allTraks) {
      const ob = getOffsetBox(t);
      if (ob) trakOffsetsList.push({ trak: t, ob, offsets: readChunkOffsets(ob) });
    }

    const dummyPayloadBytes = new Uint8Array(DUMMY_COUNT * 8);
    for (let i = 0; i < DUMMY_COUNT; i++) dummyPayloadBytes.set(DUMMY_AAC_8, i * 8);

    const origMdatPayloadStart = mdatInfo.offset + mdatInfo.headerLen;
    const origMdatPayloadLen = mdatInfo.size - mdatInfo.headerLen;
    const newMdatPayloadLen = origMdatPayloadLen + (sounTrak ? dummyPayloadBytes.length : 0);
    const newMdatHeaderLen = (mdatInfo.headerLen === 16 || (newMdatPayloadLen + 8 > 0xffffffff)) ? 16 : 8;

    for (let iter = 0; iter < 4; iter++) {
      const curMoovSize = moov.serialize().length;
      const newMdatOffset = 32 + curMoovSize + 8;
      const newMdatPayloadStart = newMdatOffset + newMdatHeaderLen;
      const delta = newMdatPayloadStart - origMdatPayloadStart;

      for (const item of trakOffsetsList) {
        const shifted = item.offsets.map((o) => o + delta);
        writeChunkOffsets(item.ob, shifted);
      }
    }

    const newMoovBytes = moov.serialize();

    let mdatHdr;
    if (newMdatHeaderLen === 16) {
      mdatHdr = concatArrays([u32(1), strToBytes("mdat"), u64(newMdatPayloadLen + 16)]);
    } else {
      mdatHdr = concatArrays([u32(newMdatPayloadLen + 8), strToBytes("mdat")]);
    }

    const outParts = [
      STANDARD_FTYP_32,
      newMoovBytes,
      FREE_BOX_8,
      mdatHdr,
      data.subarray(mdatInfo.offset + mdatInfo.headerLen, mdatInfo.offset + mdatInfo.size)
    ];
    if (sounTrak) outParts.push(dummyPayloadBytes);

    // 4MB free junk tail (dilutes bitrate & matches Haze container size)
    const junkTail = new Uint8Array(JUNK_TAIL_SIZE + 8);
    const dvJunk = new DataView(junkTail.buffer);
    dvJunk.setUint32(0, JUNK_TAIL_SIZE + 8, false);
    junkTail[4] = 0x66; junkTail[5] = 0x72; junkTail[6] = 0x65; junkTail[7] = 0x65; // "free"
    outParts.push(junkTail);

    return concatArrays(outParts);
  }

  function isAlreadyPatched(data) {
    if (!data || data.length < 100) return false;
    const str = bytesToStr(data.subarray(0, Math.min(data.length, 300000)));
    return str.includes("Rosa Quality Method") || str.includes("Haze Quality Method") || str.includes("ZILEM");
  }

  function inspectVideoMetadata(data) {
    try {
      const topBoxes = inspectTopBoxes(data);
      const moovInfo = topBoxes.find((b) => b.name === "moov");
      const mdatInfo = topBoxes.find((b) => b.name === "mdat");
      const isFastStart = moovInfo && mdatInfo && moovInfo.offset < mdatInfo.offset;
      let fps = null;
      let width = null;
      let height = null;

      if (moovInfo) {
        const moovChildren = parseBoxChildren(
          data,
          moovInfo.offset + moovInfo.headerLen,
          moovInfo.offset + moovInfo.size
        );
        const moov = new Mp4Node("moov", null, moovChildren);
        const traks = moov.findAll("trak");
        for (const t of traks) {
          const hdlr = t.path("mdia", "hdlr");
          if (hdlr && hdlr.payload.length >= 12 && bytesToStr(hdlr.payload.subarray(8, 12)) === "vide") {
            const mdhd = t.path("mdia", "mdhd");
            const stbl = t.path("mdia", "minf", "stbl");
            const stts = stbl ? stbl.find("stts") : null;
            if (mdhd && stts && stts.payload.length >= 16) {
              const v = mdhd.payload[0];
              const timescale = v === 1 ? r32(mdhd.payload, 20) : r32(mdhd.payload, 12);
              const sampleDelta = r32(stts.payload, 12);
              if (sampleDelta > 0 && timescale > 0) {
                fps = Math.round((timescale / sampleDelta) * 100) / 100;
              }
            }
            const stsd = stbl ? stbl.find("stsd") : null;
            if (stsd && stsd.payload.length >= 16) {
              const entries = parseBoxChildren(stsd.payload, 8, stsd.payload.length);
              if (entries.length > 0 && entries[0].payload.length >= 28) {
                width = (entries[0].payload[24] << 8) | entries[0].payload[25];
                height = (entries[0].payload[26] << 8) | entries[0].payload[27];
              }
            }
            break;
          }
        }
      }

      return { isFastStart: !!isFastStart, fps, width, height };
    } catch (e) {
      return { isFastStart: false, fps: null, width: null, height: null };
    }
  }

  return {
    patch: patchRosa,
    patchRosa: patchRosa,
    isAlreadyPatched: isAlreadyPatched,
    inspectVideoMetadata: inspectVideoMetadata,
  };
});
