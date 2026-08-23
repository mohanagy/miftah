import { Buffer } from "node:buffer";

export const createLineRecorder = ({ maxBufferBytes = 1024 * 1024 } = {}) => {
  const pending = {
    client: { chunks: [], bytes: 0 },
    server: { chunks: [], bytes: 0 }
  };

  return (direction, chunk, recordMessage) => {
    const state = pending[direction];
    if (chunk.length > maxBufferBytes || state.bytes + chunk.length > maxBufferBytes) {
      state.chunks = [];
      state.bytes = 0;
      return;
    }
    state.chunks.push(chunk);
    state.bytes += chunk.length;
    if (chunk.indexOf(0x0a) === -1) return;

    const buffered =
      state.chunks.length === 1 ? state.chunks[0] : Buffer.concat(state.chunks, state.bytes);
    let start = 0;
    for (;;) {
      const newline = buffered.indexOf(0x0a, start);
      if (newline === -1) break;
      const line = buffered.subarray(start, newline).toString("utf8").trim();
      start = newline + 1;
      if (line === "") continue;
      try {
        recordMessage(JSON.parse(line));
      } catch {
        // Preserve the proxied byte stream, but never persist unparsed content.
      }
    }
    const remainder = buffered.subarray(start);
    state.chunks = remainder.length === 0 ? [] : [remainder];
    state.bytes = remainder.length;
  };
};
