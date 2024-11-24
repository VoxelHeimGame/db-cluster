import { Elysia } from 'elysia'

const colors = {
  reset: '\x1b[0m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[37m',
  bgGray: '\x1b[47m',
  bgBlue: '\x1b[44m',
  bgCyan: '\x1b[46m',
  bgGreen: '\x1b[42m',
  bgMagenta: '\x1b[45m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
  bgWhite: '\x1b[47m',
  bold: '\x1b[1m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  inverse: '\x1b[7m',
  hidden: '\x1b[8m',
  strikethrough: '\x1b[9m',
  black: '\x1b[30m',
} as const

type LogLevel = 'INFO' | 'DEBUG' | 'WARN' | 'ERROR' | 'SERVER'

function getColor(level: LogLevel): string {
  switch (level) {
    case 'INFO': return colors.blue
    case 'DEBUG': return colors.yellow
    case 'WARN': return colors.yellow 
    case 'ERROR': return colors.red
    case 'SERVER': return colors.green
    default: return colors.reset
  }
}

function formatDate(date: Date): string {
  return date.toLocaleString('en-US', {
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false
  })
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const timestamp = formatDate(new Date())
  const color = getColor(level)
  let output = `${color}${level}${colors.reset} ${colors.dim}${timestamp}${colors.reset} ${message}`
  
  if (meta) {
    output += ' ' + JSON.stringify(meta)
  }
  
  console.log(output)
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => log('INFO', message, meta),
  debug: (message: string, meta?: Record<string, unknown>) => log('DEBUG', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => log('WARN', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log('ERROR', message, meta),
  server: (message: string, meta?: Record<string, unknown>) => log('SERVER', message, meta)
}

export function loggerPlugin() {
  return new Elysia({
    name: 'logger'
  })
    .onRequest(({ request }) => {
      logger.info(`Request received`, {
        method: request.method,
        url: request.url
      })
    })
    .onBeforeHandle(({ request }) => {
      logger.debug(`Processing request`, {
        method: request.method,
        url: request.url
      })
    })
    .onAfterHandle(({ request }) => {
      logger.debug(`Finished processing request`, {
        method: request.method,
        url: request.url
      })
    })
    .onError(({ error, request }) => {
      logger.error(`Error occurred`, {
        method: request.method,
        url: request.url,
        error: error.message
      })
    })
}
