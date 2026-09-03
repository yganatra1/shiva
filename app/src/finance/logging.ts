export interface FinanceLogSink {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export function consoleFinanceLogger(): FinanceLogSink {
  return {
    info(fields, message) {
      console.info(message, fields);
    },
    warn(fields, message) {
      console.warn(message, fields);
    },
    error(fields, message) {
      console.error(message, fields);
    },
  };
}

export function silentFinanceLogger(): FinanceLogSink {
  return {
    info() {},
    warn() {},
    error() {},
  };
}
