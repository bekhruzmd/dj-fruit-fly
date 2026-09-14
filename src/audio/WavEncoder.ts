export function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const samples = chunks.reduce((n, chunk) => n + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clamped < 0 ? clamped * 32768 : clamped * 32767, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

