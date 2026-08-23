import { Buffer } from "node:buffer";

export const createLineRecorder = ({ maxBufferBytes = 1024 * 1024 } = {}) => {
  const buffers = { client: Buffer.alloc(0), server: Buffer.alloc(0) };

  return (direction, chunk, recordMessage) => {
    if (chunk.length > maxBufferBytes || buffers[direction].length + chunk.length > maxBufferBytes) {
      buffers[direction] = Buffer.alloc(0);
      return;
    }
    buffers[direction] =
      buffers[direction].length === 0
        ? chunk
        : Buffer.concat([buffers[direction], chunk], buffers[direction].length + chunk.length);
    for (;;) {
      const newline = buffers[direction].indexOf(0x0a);
      if (newline === -1) return;
      const line = buffers[direction].subarray(0, newline).toString("utf8").trim();
      buffers[direction] = buffers[direction].subarray(newline + 1);
      if (line === "") continue;
      try {
        recordMessage(JSON.parse(line));
      } catch {
        // Preserve the proxied byte stream, but never persist unparsed content.
      }
    }
  };
};
