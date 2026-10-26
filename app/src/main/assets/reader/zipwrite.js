// Minimal ZIP writer (STORE method, no compression) producing a Blob. Enough for backups:
// book files are already compressed, and the reader's zip.js build is read-only.
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
const crc32 = async blob => {
    let crc = 0xFFFFFFFF
    const CHUNK = 4 * 1024 * 1024
    for (let off = 0; off < blob.size; off += CHUNK) {
        const bytes = new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer())
        for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8)
    }
    return (crc ^ 0xFFFFFFFF) >>> 0
}
const dosDateTime = d => {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    return { time, date }
}
const u16 = n => [n & 0xFF, (n >>> 8) & 0xFF]
const u32 = n => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]

export class ZipWriter {
    constructor() { this.parts = []; this.entries = []; this.offset = 0; this.enc = new TextEncoder() }
    /** data: Blob | string */
    async add(name, data) {
        const blob = typeof data === 'string' ? new Blob([data]) : data
        const nameBytes = this.enc.encode(name)
        const crc = await crc32(blob)
        const { time, date } = dosDateTime(new Date())
        const size = blob.size
        const header = new Uint8Array([
            ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(time), ...u16(date),
            ...u32(crc), ...u32(size), ...u32(size), ...u16(nameBytes.length), ...u16(0),
        ])
        this.entries.push({ nameBytes, crc, size, time, date, offset: this.offset })
        this.parts.push(header, nameBytes, blob)
        this.offset += header.length + nameBytes.length + size
    }
    close() {
        const cdParts = []
        let cdSize = 0
        for (const e of this.entries) {
            const h = new Uint8Array([
                ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(e.time), ...u16(e.date),
                ...u32(e.crc), ...u32(e.size), ...u32(e.size), ...u16(e.nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
                ...u32(0), ...u32(e.offset),
            ])
            cdParts.push(h, e.nameBytes); cdSize += h.length + e.nameBytes.length
        }
        const eocd = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(this.entries.length), ...u16(this.entries.length), ...u32(cdSize), ...u32(this.offset), ...u16(0)])
        return new Blob([...this.parts, ...cdParts, eocd], { type: 'application/zip' })
    }
}
