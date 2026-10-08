import { spawn } from 'node:child_process';

// Custom is intentionally a restricted subset of FFmpeg's -af syntax. FFmpeg
// graph strings are executable programs (some filters open files and URLs).
// Never pass user-supplied filtergraphs or command line arguments to FFmpeg.
const allowed = Object.freeze({
  volume: { volume: [0, 3] },
  highpass: { f: [40, 8000] },
  lowpass: { f: [100, 18000] },
  atempo: { tempo: [0.75, 1.5] },
  vibrato: { f: [0.1, 12], d: [0, 1] },
  tremolo: { f: [0.1, 15], d: [0, 1] },
  acrusher: { bits: [2, 16], mix: [0, 1] },
  aecho: { in_gain: [0, 1], out_gain: [0, 1], delays: [20, 600], decays: [0, 0.8] },
});

export class CustomAudioError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function finiteDecimal(value, [min, max]) {
  if (!/^(?:\d{1,5}(?:\.\d{1,3})?|\.\d{1,3})$/.test(value)) throw new CustomAudioError('Custom: numeric values only');
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new CustomAudioError(`Custom: value outside ${min}–${max}`);
  return String(number);
}

export function parseCustomAudioArgs(value) {
  if (typeof value !== 'string' || value.length > 256) throw new CustomAudioError('Custom: arguments must be at most 256 characters');
  const match = /^\s*-(?:af|filter:a)\s+(.+?)\s*$/.exec(value);
  if (!match) throw new CustomAudioError('Custom: only -af <audio filters> is supported');
  let graph = match[1];
  if ((graph.startsWith('"') && graph.endsWith('"')) || (graph.startsWith("'") && graph.endsWith("'"))) graph = graph.slice(1, -1);
  if (!graph || graph.length > 240 || !/^[a-z0-9_.,:=]+$/.test(graph)) throw new CustomAudioError('Custom: unsupported characters in filters');
  const filters = graph.split(',');
  if (filters.length > 6) throw new CustomAudioError('Custom: maximum 6 filters');
  return filters.map(filter => {
    const equals = filter.indexOf('=');
    if (equals < 1) throw new CustomAudioError('Custom: use filter=options');
    const name = filter.slice(0, equals);
    const parameters = allowed[name];
    if (!parameters) throw new CustomAudioError(`Custom: filter ${name.slice(0, 32)} is not permitted`);
    let pieces = filter.slice(equals + 1).split(':');
    if (name === 'volume' && pieces.length === 1 && !pieces[0].includes('=')) pieces = [`volume=${pieces[0]}`];
    if (name === 'atempo' && pieces.length === 1 && !pieces[0].includes('=')) pieces = [`tempo=${pieces[0]}`];
    const values = new Map();
    for (const piece of pieces) {
      const separator = piece.indexOf('=');
      if (separator < 1) throw new CustomAudioError('Custom: use named filter parameters');
      const key = piece.slice(0, separator);
      if (!Object.hasOwn(parameters, key) || values.has(key)) throw new CustomAudioError('Custom: unknown or duplicate filter parameter');
      values.set(key, finiteDecimal(piece.slice(separator + 1), parameters[key]));
    }
    if (values.size !== Object.keys(parameters).length && !['volume', 'highpass', 'lowpass', 'atempo'].includes(name)) {
      throw new CustomAudioError('Custom: specify every parameter for this filter');
    }
    if (values.size !== Object.keys(parameters).length) throw new CustomAudioError('Custom: missing filter parameter');
    // Generate the graph from a fixed map and normalized numbers, never from
    // arbitrary client bytes. No file/URL/script filters or graph linking.
    if (name === 'volume' || name === 'atempo') return `${name}=${values.values().next().value}`;
    return `${name}=${Object.keys(parameters).map(key => `${key}=${values.get(key)}`).join(':')}`;
  }).join(',');
}

export async function runCustomAudio(ffmpegPath, inputPath, outputPath, graph, seconds) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
    '-protocol_whitelist', 'file,pipe', '-i', inputPath,
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-filter_threads', '1',
    '-af', graph, '-t', String(Math.min(120, Math.max(2, seconds + 2))),
    '-c:a', 'libopus', '-application', 'voip', '-b:a', '96k', '-ac', '1', '-ar', '48000',
    '-f', 'webm', '-y', outputPath,
  ];
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: 'ignore', shell: false });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15000);
    child.once('error', error => { clearTimeout(timeout); reject(new CustomAudioError(error.code === 'ENOENT' ? 'FFmpeg is not installed on the server' : 'Custom audio processing failed', 503)); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (timedOut || code !== 0) reject(new CustomAudioError(timedOut ? 'Custom audio timed out' : 'Custom audio processing failed', 422));
      else resolve();
    });
  });
}
