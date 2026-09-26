export const SAMPLE_RATE = 16_000;
export const FRAME_BYTES = 960; // 30 ms, mono signed 16-bit PCM

export function rms(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sum = 0;
  const samples = Math.floor(pcm.byteLength / 2);
  for (let i = 0; i < samples; i++) sum += (view.getInt16(i * 2, true) / 32768) ** 2;
  return samples ? Math.sqrt(sum / samples) : 0;
}

export function wavFromPcm(pcm: Uint8Array, rate = SAMPLE_RATE): Buffer {
  const wav = Buffer.alloc(44 + pcm.byteLength);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcm.byteLength, 40);
  wav.set(pcm, 44);
  return wav;
}

export function readWav(wav: Buffer): { pcm: Buffer; rate: number; channels: number; duration: number } {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("语音服务未返回有效 WAV");
  let rate = 0;
  let channels = 0;
  let pcm: Buffer | undefined;
  for (let offset = 12; offset + 8 <= wav.length; ) {
    const name = wav.toString("ascii", offset, offset + 4);
    const length = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > wav.length) throw new Error("WAV 数据不完整");
    if (name === "fmt ") {
      if (length < 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 14) !== 16)
        throw new Error("只支持 PCM 16-bit WAV");
      channels = wav.readUInt16LE(start + 2);
      rate = wav.readUInt32LE(start + 4);
    } else if (name === "data") pcm = wav.subarray(start, start + length);
    offset = start + length + (length % 2);
  }
  if (!pcm?.length || rate < 8000 || rate > 192000 || channels < 1 || channels > 2 || pcm.length % (2 * channels))
    throw new Error("WAV 音频格式无效");
  return { pcm, rate, channels, duration: pcm.length / (rate * channels * 2) };
}
