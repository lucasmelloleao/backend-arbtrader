import pino from 'pino';
import promClient from 'prom-client';

// Environment detection
const NODE_ENV = process.env.NODE_ENV || 'development';

// Create pino logger with structured format
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: undefined,
});

// Prometheus metrics
const register = new promClient.Registry();
const defaultMetrics = promClient.collectDefaultMetrics({ register });

// Custom metrics for Prediction Arb
export const predictionArbMetrics = {
  scanCyclesTotal: new promClient.Counter({
    name: 'prediction_arb_scan_cycles_total',
    help: 'Total number of scan cycles executed',
    labelNames: ['status'],
  }),
  openStrategies: new promClient.Gauge({
    name: 'prediction_arb_open_strategies',
    help: 'Number of currently open prediction arbitrage strategies',
  }),
  orderPlacementsTotal: new promClient.Counter({
    name: 'prediction_arb_order_placements_total',
    help: 'Total number of orders placed',
    labelNames: ['side', 'result'],
  }),
  orderFillsTotal: new promClient.Counter({
    name: 'prediction_arb_order_fills_total',
    help: 'Total number of order fills',
    labelNames: ['side'],
  }),
  dailyLossUsd: new promClient.Gauge({
    name: 'prediction_arb_daily_loss_usd',
    help: 'Daily loss in USD for prediction arbitrage',
  }),
  uptimeSeconds: new promClient.Gauge({
    name: 'prediction_arb_uptime_seconds',
    help: 'Bot uptime in seconds',
  }),
};

// Register custom metrics
register.registerMetric(predictionArbMetrics.scanCyclesTotal);
register.registerMetric(predictionArbMetrics.openStrategies);
register.registerMetric(predictionArbMetrics.orderPlacementsTotal);
register.registerMetric(predictionArbMetrics.orderFillsTotal);
register.registerMetric(predictionArbMetrics.dailyLossUsd);
register.registerMetric(predictionArbMetrics.uptimeSeconds);

// Export metrics endpoint middleware
export async function metricsMiddleware(req: any, res: any, next: any) {
  try {
    res.setHeader('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (e: any) {
    next(e);
  }
}

// Export logger with enhanced methods
export const structuredLogger = {
  info: (message: string, context?: Record<string, any>) => {
    logger.info({ ...context, env: NODE_ENV }, message);
  },
  warn: (message: string, context?: Record<string, any>) => {
    logger.warn({ ...context, env: NODE_ENV }, message);
  },
  error: (message: string, context?: Record<string, any>) => {
    logger.error({ ...context, env: NODE_ENV }, message);
  },
  debug: (message: string, context?: Record<string, any>) => {
    logger.debug({ ...context, env: NODE_ENV }, message);
  },
};

// Export raw logger for backward compatibility
export { logger };

// Update metrics every tick
let scanCount = 0;
export function incrementScanCounter() {
  predictionArbMetrics.scanCyclesTotal.inc({ status: 'completed' });
  scanCount++;
}

// Export uptime tracker
export function startUptimeTracker() {
  predictionArbMetrics.uptimeSeconds.set(process.uptime());
  setInterval(() => {
    predictionArbMetrics.uptimeSeconds.set(process.uptime());
  }, 10_000);
}

export default logger;