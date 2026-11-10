const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[process.env.SG_LOG_LEVEL ?? 'info'] ?? LEVELS.info;

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function emit(level, args) {
  if (LEVELS[level] > threshold) return;
  const line = `${stamp()} ${level.toUpperCase().padEnd(5)} ${args.map(fmt).join(' ')}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

const fmt = (a) => (typeof a === 'string' ? a : a instanceof Error ? (a.stack ?? a.message) : JSON.stringify(a));

export const log = {
  error: (...a) => emit('error', a),
  warn: (...a) => emit('warn', a),
  info: (...a) => emit('info', a),
  debug: (...a) => emit('debug', a),
  // Progress on one line; callers decide the cadence.
  step: (msg) => emit('info', [msg]),
};
