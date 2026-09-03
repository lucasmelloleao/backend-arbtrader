export type LogFields = Record<string, unknown>;

function write(level: string, message: string, args: unknown[]): void {
  const fields = args.length === 1 && typeof args[0] === 'object' && args[0] !== null
    ? args[0] as LogFields
    : args.length > 0 ? { args } : {};
  const entry = { time: new Date().toISOString(), level, message, ...fields };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

export const logger = {
  info(message: string, ...args: unknown[]): void { write('info', message, args); },
  warn(message: string, ...args: unknown[]): void { write('warn', message, args); },
  error(message: string, ...args: unknown[]): void { write('error', message, args); },
};
