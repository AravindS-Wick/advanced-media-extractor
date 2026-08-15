// Client-side ZIP Archive Generator (Zero Dependencies)
// Packaging files into a standard .zip archive using uncompressed Store mode (ideal for images/video/audio)

class ZipBuilder {
  constructor() {
    this.files = [];
  }

  // Add a file entry (Uint8Array or ArrayBuffer or String)
  addFile(name, content) {
    let data;
    if (typeof content === 'string') {
      data = new TextEncoder().encode(content);
    } else if (content instanceof ArrayBuffer) {
      data = new Uint8Array(content);
    } else if (content instanceof Uint8Array) {
      data = content;
    } else {
      data = new Uint8Array(0);
    }

    const nameBytes = new TextEncoder().encode(name);
    const crc = this.crc32(data);

    this.files.push({
      name: nameBytes,
      data: data,
      crc: crc,
      size: data.length,
    });
  }

  // Generate ZIP Blob
  build() {
    const parts = [];
    const centralDirectoryParts = [];
    let offset = 0;

    for (const file of this.files) {
      // Local File Header
      const header = new Uint8Array(30 + file.name.length);
      const view = new DataView(header.buffer);

      view.setUint32(0, 0x04034b50, true); // Local header signature
      view.setUint16(4, 10, true);         // Version needed
      view.setUint16(6, 0, true);          // General flag
      view.setUint16(8, 0, true);          // Compression method (0 = store)
      view.setUint16(10, 0, true);         // Mod time
      view.setUint16(12, 0, true);         // Mod date
      view.setUint32(14, file.crc, true);  // CRC32
      view.setUint32(18, file.size, true); // Compressed size
      view.setUint32(22, file.size, true); // Uncompressed size
      view.setUint16(26, file.name.length, true); // Filename length
      view.setUint16(28, 0, true);         // Extra field length

      header.set(file.name, 30);

      parts.push(header);
      parts.push(file.data);

      // Central Directory Header
      const cdHeader = new Uint8Array(46 + file.name.length);
      const cdView = new DataView(cdHeader.buffer);

      cdView.setUint32(0, 0x02014b50, true); // Central header signature
      cdView.setUint16(4, 20, true);         // Version made by
      cdView.setUint16(6, 10, true);         // Version needed
      cdView.setUint16(8, 0, true);          // General flag
      cdView.setUint16(10, 0, true);         // Compression method
      cdView.setUint16(12, 0, true);         // Mod time
      cdView.setUint16(14, 0, true);         // Mod date
      cdView.setUint32(16, file.crc, true);  // CRC32
      cdView.setUint32(20, file.size, true); // Compressed size
      cdView.setUint32(24, file.size, true); // Uncompressed size
      cdView.setUint16(28, file.name.length, true); // Filename length
      cdView.setUint16(30, 0, true);         // Extra field length
      cdView.setUint16(32, 0, true);         // Comment length
      cdView.setUint16(34, 0, true);         // Disk start
      cdView.setUint16(36, 0, true);         // Internal attr
      cdView.setUint32(38, 0, true);         // External attr
      cdView.setUint32(42, offset, true);    // Local header offset

      cdHeader.set(file.name, 46);
      centralDirectoryParts.push(cdHeader);

      offset += header.length + file.data.length;
    }

    let centralDirSize = 0;
    for (const cd of centralDirectoryParts) {
      parts.push(cd);
      centralDirSize += cd.length;
    }

    // End of Central Directory Record
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);

    eocdView.setUint32(0, 0x06054b50, true);                // EOCD signature
    eocdView.setUint16(4, 0, true);                         // Disk number
    eocdView.setUint16(6, 0, true);                         // Disk with CD
    eocdView.setUint16(8, this.files.length, true);         // CD entries on disk
    eocdView.setUint16(10, this.files.length, true);        // Total CD entries
    eocdView.setUint32(12, centralDirSize, true);           // CD size
    eocdView.setUint32(16, offset, true);                   // CD offset
    eocdView.setUint16(20, 0, true);                        // Comment length

    parts.push(eocd);

    return new Blob(parts, { type: 'application/zip' });
  }

  // CRC-32 Checksum table computation
  crc32(buf) {
    if (!ZipBuilder.crcTable) {
      ZipBuilder.crcTable = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) {
          c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        ZipBuilder.crcTable[i] = c;
      }
    }

    let crc = 0xffffffff;
    const table = ZipBuilder.crcTable;
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
}

if (typeof window !== 'undefined') {
  window.ZipBuilder = ZipBuilder;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ZipBuilder;
}
