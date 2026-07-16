export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Structured JSON-lines logger (pino-compatible field shape: level, time, msg).
 * Deliberately dependency-free; swap in your own via createApp({ logger }).
 */
export function createLogger(options: { level?: LogLevel; sink?: (line: string) => void } = {}, bindings: Record<string, unknown> = {}): Logger {
  const min = LEVELS[options.level ?? 'info'];
  const sink = options.sink ?? ((line: string) => process.stdout.write(line + '\n'));

  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVELS[level] < min) return;
    sink(JSON.stringify({ level, time: new Date().toISOString(), msg, ...bindings, ...fields }));
  };

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (childBindings) => createLogger(options, { ...bindings, ...childBindings }),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
