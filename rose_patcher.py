import json
import os
import struct
import sys
from pathlib import Path

# =============================================================================
# CONSTANTS & TEMPLATES
# =============================================================================
STANDARD_FTYP_32 = b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00isomiso2avc1mp41"
FREE_BOX_8 = b"\x00\x00\x00\x08free"

DUMMY_AAC_8 = b"\x00\x00\x00\x04\x00\x00\x00\x00"
DUMMY_COUNT = 4194
DUMMY_PAYLOAD = DUMMY_AAC_8 * DUMMY_COUNT

ROSA_TAG_TEXT = "Rosa Quality Method https://leemonr0.github.io/Rosamethod/ | Rosa Pro"

def build_rosa_udta() -> bytes:
    tag_bytes = ROSA_TAG_TEXT.encode("utf-8")
    data_atom = struct.pack(">I", len(tag_bytes) + 16) + b"data" + struct.pack(">I", 1) + struct.pack(">I", 0) + tag_bytes
    too_atom = struct.pack(">I", len(data_atom) + 8) + b"\xa9too" + data_atom
    ilst_atom = struct.pack(">I", len(too_atom) + 8) + b"ilst" + too_atom
    hdlr_atom = b"\x00\x00\x00!hdlr\x00\x00\x00\x00\x00\x00\x00\x00mdir\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"
    meta_atom = struct.pack(">I", len(hdlr_atom) + len(ilst_atom) + 12) + b"meta" + struct.pack(">I", 0) + hdlr_atom + ilst_atom
    udta_atom = struct.pack(">I", len(meta_atom) + 8) + b"udta" + meta_atom
    return udta_atom

ROSA_UDTA = build_rosa_udta()

# =============================================================================
# LOW-LEVEL BINARY HELPERS
# =============================================================================
def u32(val: int) -> bytes:
    return struct.pack(">I", val & 0xFFFFFFFF)

def u64(val: int) -> bytes:
    return struct.pack(">Q", val & 0xFFFFFFFFFFFFFFFF)

def r32(d: bytes, o: int) -> int:
    return struct.unpack(">I", d[o : o + 4])[0]

def r64(d: bytes, o: int) -> int:
    return struct.unpack(">Q", d[o : o + 8])[0]

def inspect_top_boxes(data: bytes) -> list[dict]:
    boxes = []
    pos = 0
    while pos + 8 <= len(data):
        sz = r32(data, pos)
        hdr = 8
        if sz == 1:
            if pos + 16 > len(data): break
            sz = r64(data, pos + 8)
            hdr = 16
        elif sz == 0:
            sz = len(data) - pos
        if sz < hdr or pos + sz > len(data): break
        name = data[pos + 4 : pos + 8].decode("latin1", errors="replace")
        boxes.append({"name": name, "offset": pos, "size": sz, "headerLen": hdr})
        pos += sz
    return boxes

class Mp4Node:
    def __init__(self, box_type: str, payload: bytes | None = None, children: list | None = None):
        self.type = box_type
        self.payload = payload
        self.children = children

    def find(self, box_type: str):
        if not self.children: return None
        for c in self.children:
            if c.type == box_type: return c
        return None

    def find_all(self, box_type: str) -> list:
        if not self.children: return []
        return [c for c in self.children if c.type == box_type]

    def path(self, *types):
        curr = self
        for t in types:
            curr = curr.find(t)
            if not curr: return None
        return curr

    def serialize(self) -> bytes:
        if self.children is not None:
            body = b"".join(c.serialize() for c in self.children)
        else:
            body = self.payload or b""
        total_len = len(body) + 8
        if total_len > 0xFFFFFFFF:
            return u32(1) + self.type.encode("latin1") + u64(total_len + 8) + body
        return u32(total_len) + self.type.encode("latin1") + body

CONTAINER_TYPES = {"moov", "trak", "mdia", "minf", "stbl", "edts", "udta", "meta", "ilst"}

def parse_box_children(data: bytes, start: int, end: int) -> list[Mp4Node]:
    nodes = []
    pos = start
    while pos + 8 <= end:
        sz = r32(data, pos)
        hdr = 8
        if sz == 1:
            if pos + 16 > end: break
            sz = r64(data, pos + 8)
            hdr = 16
        elif sz == 0:
            sz = end - pos
        if sz < hdr or pos + sz > end: break
        typ = data[pos + 4 : pos + 8].decode("latin1", errors="replace")
        content_start = pos + hdr
        content_end = pos + sz
        if typ == "meta":
            content_start += 4

        if typ in CONTAINER_TYPES:
            children = parse_box_children(data, content_start, content_end)
            nodes.append(Mp4Node(typ, None, children))
        else:
            nodes.append(Mp4Node(typ, data[content_start:content_end], None))
        pos += sz
    return nodes

def upgrade_mvhd_to_v1_sentinel(mvhd_payload: bytes) -> bytes:
    ver = mvhd_payload[0]
    flags = mvhd_payload[1:4]
    if ver == 0:
        c_time = r32(mvhd_payload, 4)
        m_time = r32(mvhd_payload, 8)
        timescale = r32(mvhd_payload, 12)
        rest = mvhd_payload[20:]
        return b"\x01" + flags + u64(c_time) + u64(m_time) + u32(timescale) + u64(0xFFFFFFFFFFFFFFFF) + rest
    else:
        c_time = r64(mvhd_payload, 4)
        m_time = r64(mvhd_payload, 12)
        timescale = r32(mvhd_payload, 20)
        rest = mvhd_payload[32:]
        return b"\x01" + flags + u64(c_time) + u64(m_time) + u32(timescale) + u64(0xFFFFFFFFFFFFFFFF) + rest

def get_track_handler(trak: Mp4Node) -> str:
    hdlr = trak.path("mdia", "hdlr")
    if not hdlr or len(hdlr.payload) < 12: return ""
    return hdlr.payload[8:12].decode("latin1", errors="replace")

def get_offset_box(trak: Mp4Node):
    stbl = trak.path("mdia", "minf", "stbl")
    if not stbl: return None
    return stbl.find("stco") or stbl.find("co64")

def read_chunk_offsets(box: Mp4Node) -> list[int]:
    if box.type == "stco":
        cnt = r32(box.payload, 4)
        return [r32(box.payload, 8 + i * 4) for i in range(cnt)]
    elif box.type == "co64":
        cnt = r32(box.payload, 4)
        return [r64(box.payload, 8 + i * 8) for i in range(cnt)]
    return []

def write_chunk_offsets(box: Mp4Node, offsets: list[int]):
    needs_co64 = any(o > 0xFFFFFFFF for o in offsets)
    if needs_co64 or box.type == "co64":
        box.type = "co64"
        box.payload = b"\x00\x00\x00\x00" + u32(len(offsets)) + b"".join(u64(o) for o in offsets)
    else:
        box.type = "stco"
        box.payload = b"\x00\x00\x00\x00" + u32(len(offsets)) + b"".join(u32(o) for o in offsets)

# =============================================================================
# UNIFIED ROSA PRO ENGINE (1080P 120FPS TIKTOK BYPASS)
# =============================================================================
def patch_rosa(data: bytes) -> bytes:
    """
    Rosa Pro Unified Bypass Engine:
    1. Upgrades mvhd to v1 sentinel duration = 0xFFFFFFFFFFFFFFFF.
    2. Zeroes out declared video dimensions in stsd to 0x0 (bypasses TikTok 1080->576 downscale matrix).
    3. Clones audio track as Track 3 with 10x sample inflation (4,194 dummy 8B AAC frames in mdat).
    4. Writes official Rosa metadata: 'Rosa Quality Method https://leemonr0.github.io/Rosamethod/ | Rosa Pro'.
    5. Universal FastStart shift: positions moov at offset 32 (immediately after ftyp).
    """
    top_boxes = inspect_top_boxes(data)
    moov_info = next(b for b in top_boxes if b["name"] == "moov")
    mdat_info = next(b for b in top_boxes if b["name"] == "mdat")

    moov_children = parse_box_children(data, moov_info["offset"] + moov_info["headerLen"], moov_info["offset"] + moov_info["size"])
    moov = Mp4Node("moov", None, moov_children)

    # 1. Upgrade mvhd sentinel v1
    mvhd = moov.find("mvhd")
    if not mvhd: raise ValueError("Missing mvhd box.")
    mvhd.payload = upgrade_mvhd_to_v1_sentinel(mvhd.payload)

    # 2. Modify video track stsd: zero out width & height
    traks = moov.find_all("trak")
    vide_trak = next((t for t in traks if get_track_handler(t) == "vide"), None)
    soun_trak = next((t for t in traks if get_track_handler(t) == "soun"), None)
    if not vide_trak: raise ValueError("Missing video track.")

    stsd = vide_trak.path("mdia", "minf", "stbl", "stsd")
    if stsd and len(stsd.payload) >= 44:
        pl = bytearray(stsd.payload)
        pl[40:44] = b"\x00\x00\x00\x00"
        stsd.payload = bytes(pl)

    # 3. Clone audio track into Track 3 with 10x sample inflation
    if soun_trak:
        soun_bytes = soun_trak.serialize()
        soun_clone_children = parse_box_children(soun_bytes, 8, len(soun_bytes))
        trak3 = Mp4Node("trak", None, soun_clone_children)

        tkhd3 = trak3.find("tkhd")
        if tkhd3 and len(tkhd3.payload) >= 20:
            pl = bytearray(tkhd3.payload)
            ver = pl[0]
            track_id_offset = 12 if ver == 0 else 16
            pl[track_id_offset:track_id_offset+4] = u32(3)
            tkhd3.payload = bytes(pl)

        stts3 = trak3.path("mdia", "minf", "stbl", "stts")
        if stts3:
            cnt = r32(stts3.payload, 4)
            entries = [[r32(stts3.payload, 8 + i*8), r32(stts3.payload, 12 + i*8)] for i in range(cnt)]
            entries.append([DUMMY_COUNT, 1])
            stts3.payload = stts3.payload[:4] + u32(len(entries)) + b"".join(u32(c) + u32(d) for c, d in entries)

        stsc3 = trak3.path("mdia", "minf", "stbl", "stsc")
        ob3 = get_offset_box(trak3)
        orig_offs3 = read_chunk_offsets(ob3) if ob3 else []
        last_chunk_idx = len(orig_offs3)
        if stsc3 and last_chunk_idx > 0:
            sc_cnt = r32(stsc3.payload, 4)
            sc_entries = [
                (r32(stsc3.payload, 8 + i*12), r32(stsc3.payload, 12 + i*12), r32(stsc3.payload, 16 + i*12))
                for i in range(sc_cnt)
            ]
            sc_entries.append((last_chunk_idx, 1 + DUMMY_COUNT, 1))
            stsc3.payload = stsc3.payload[:4] + u32(len(sc_entries)) + b"".join(u32(a) + u32(b) + u32(c) for a, b, c in sc_entries)

        stsz3 = trak3.path("mdia", "minf", "stbl", "stsz")
        if stsz3:
            s_fixed = r32(stsz3.payload, 4)
            s_cnt = r32(stsz3.payload, 8)
            s_sizes = [s_fixed] * s_cnt if s_fixed != 0 else [r32(stsz3.payload, 12 + i*4) for i in range(s_cnt)]
            new_sizes = s_sizes + [8] * DUMMY_COUNT
            stsz3.payload = stsz3.payload[:4] + u32(0) + u32(len(new_sizes)) + b"".join(u32(s) for s in new_sizes)

        moov.children.append(trak3)

    # 4. Inject official Rosa UDTA
    udta = moov.find("udta")
    if udta:
        moov.children = [c for c in moov.children if c.type != "udta"]
    moov.children.append(Mp4Node("udta", ROSA_UDTA[8:]))

    # 5. Shift all chunk offsets in strict FastStart layout [ftyp, moov (at 32B), free (8B), mdat]
    all_traks = moov.find_all("trak")
    trak_orig_offsets = []
    for t in all_traks:
        ob = get_offset_box(t)
        trak_orig_offsets.append((t, ob, read_chunk_offsets(ob) if ob else []))

    orig_mdat_payload_start = mdat_info["offset"] + mdat_info["headerLen"]
    orig_mdat_payload_len = mdat_info["size"] - mdat_info["headerLen"]
    new_mdat_payload_len = orig_mdat_payload_len + (len(DUMMY_PAYLOAD) if soun_trak else 0)
    new_mdat_hdr_len = 16 if (mdat_info["headerLen"] == 16 or (new_mdat_payload_len + 8 > 0xFFFFFFFF)) else 8

    for _ in range(4):
        cur_moov_size = len(moov.serialize())
        new_mdat_offset = 32 + cur_moov_size + 8
        new_mdat_payload_start = new_mdat_offset + new_mdat_hdr_len
        delta = new_mdat_payload_start - orig_mdat_payload_start

        for t, ob, orig_offs in trak_orig_offsets:
            if not ob: continue
            shifted = [o + delta for o in orig_offs]
            write_chunk_offsets(ob, shifted)

    new_moov_bytes = moov.serialize()

    if new_mdat_hdr_len == 16:
        new_mdat_hdr = u32(1) + b"mdat" + u64(new_mdat_payload_len + 16)
    else:
        new_mdat_hdr = u32(new_mdat_payload_len + 8) + b"mdat"

    orig_mdat_payload = data[mdat_info["offset"] + mdat_info["headerLen"] : mdat_info["offset"] + mdat_info["size"]]

    out_parts = [
        STANDARD_FTYP_32,
        new_moov_bytes,
        FREE_BOX_8,
        new_mdat_hdr,
        orig_mdat_payload
    ]
    if soun_trak:
        out_parts.append(DUMMY_PAYLOAD)

    return b"".join(out_parts)

def apply_rose_binary_patch(input_mp4_path: Path, output_mp4_path: Path, mode: str = "rosa") -> dict:
    raw_bytes = input_mp4_path.read_bytes()
    patched_bytes = patch_rosa(raw_bytes)
    output_mp4_path.write_bytes(patched_bytes)
    return {
        "engine": "rosa_pro_1080p120",
        "file_size": len(patched_bytes)
    }

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Rosa Pro MP4 Binary Container Patcher (1080p 120FPS)")
    parser.add_argument("input", help="Path to input MP4 video")
    parser.add_argument("output", help="Path to output patched MP4 video")
    parser.add_argument("--mode", default="rosa", help="Bypass mode")
    args = parser.parse_args()

    res = apply_rose_binary_patch(Path(args.input), Path(args.output), mode=args.mode)
    print(f"[OK] Patched successfully with Rosa Pro Engine! File Size: {res.get('file_size')} bytes")
