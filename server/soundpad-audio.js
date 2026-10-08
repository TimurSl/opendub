import { open } from 'node:fs/promises';
import { spawn } from 'node:child_process';

// The browser only supplies sound bytes. Never accept a filename, input URL,
// filtergraph, or FFmpeg argv from the client.
const formats = Object.freeze({
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/ogg': 'ogg', 'audio/flac': 'flac',
  'audio/webm': 'matroska', 'audio/mp4': 'mov', 'audio/x-m4a': 'mov',
});

export function soundpadFormat(mime) { return formats[mime] || null; }

export function soundpadMagicValid(mime, bytes) {
  const format = soundpadFormat(mime);
  if (!format || bytes.length < 12) return false;
  if (format === 'mp3') return bytes.subarray(0, 3).toString() === 'ID3' ||
    (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0);
  if (format === 'wav') return bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE';
  if (format === 'ogg') return bytes.subarray(0, 4).toString() === 'OggS';
  if (format === 'flac') return bytes.subarray(0, 4).toString() === 'fLaC';
  if (format === 'matroska') return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (format === 'mov') return bytes.subarray(4, 8).toString() === 'ftyp';
  return false;
}

export async function checkSoundpadFile(filePath, mime) {
  const handle = await open(filePath, 'r');
  const magic = Buffer.alloc(16);
  try {
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    if (!soundpadMagicValid(mime, magic.subarray(0, bytesRead))) {
      const error = new Error('Unsupported audio file or invalid file signature');
      error.status = 415; throw error;
    }
  } finally { await handle.close(); }
}

export async function runSoundpadAudio(ffmpegPath, inputPath, outputPath, mime, lineDuration) {
  const format = soundpadFormat(mime);
  if (!format || !Number.isFinite(lineDuration) || lineDuration <= 0 || lineDuration > 120) {
    const error = new Error('Invalid sound format or line duration'); error.status = 400; throw error;
  }
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
    '-protocol_whitelist', 'file,pipe', '-f', format, '-i', inputPath,
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-filter_threads', '1',
    '-t', String(Math.min(122, lineDuration + 2)),
    '-c:a', 'libopus', '-application', 'voip', '-b:a', '96k', '-ac', '1', '-ar', '48000',
    '-f', 'webm', '-y', outputPath,
  ];
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { shell: false, stdio: 'ignore' });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 20000);
    child.once('error', error => {
      clearTimeout(timeout);
      const failure = new Error(error.code === 'ENOENT' ? 'FFmpeg is not installed on the server' : 'Sound conversion failed');
      failure.status = 503; reject(failure);
    });
    child.once('close', code => {
      clearTimeout(timeout);
      if (code === 0 && !timedOut) resolve();
      else { const failure = new Error(timedOut ? 'Sound conversion timed out' : 'Audio could not be decoded'); failure.status = 422; reject(failure); }
    });
  });
}
