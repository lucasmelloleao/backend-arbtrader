import { loadEnv } from './utils/env-loader';
loadEnv();

import express from 'express';
import cors from 'cors';
import { connectToDatabase } from './config/db';
import authRoutes from './routes/authRoutes';
import mongoose from 'mongoose';
import logger, { structuredLogger, incrementScanCounter, startUptimeTracker, metricsMiddleware } from './utils/logger';
import { predictionArbMetrics } from './utils/logger';

const app = express();
const PORT = process.env.PORT || 4002;

// Structured logging middleware
app.use((req: any, res, next) => {
  structuredLogger.info(` ${req.method} ${req.path} - ${req.ip}`, { userId: req.userId });
  next();
});

// Standard Middlewares
const allowedOrigins = (process.env.ALLOWED_ORIGIN || 'http://localhost:8080,http://localhost:3000')
  .split(',')
  .map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    if (
      !origin ||
      allowedOrigins.includes(origin) ||
      allowedOrigins.includes('*') ||
      origin.startsWith('http://localhost:') ||
      origin.startsWith('http://127.0.0.1:') ||
      origin.endsWith('.vercel.app') ||
      origin.includes('arbtraders')
    ) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json());

// Main authentication router v1
app.use('/api/v1', authRoutes);

// Metrics endpoint - Prometheus format
app.use('/metrics', metricsMiddleware);

// Health check endpoint
app.get('/health', (req: any, res) => {
  structuredLogger.info('Health check requested');
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});

app.get('/healthz', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.get('/readyz', (req, res) => {
  const ready = mongoose.connection.readyState === 1;
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not-ready', database: ready ? 'connected' : 'disconnected' });
});

// Start database connection then start listening
(async () => {
  try {
    await connectToDatabase();

    // Limpeza única de ruído: remove operações da Polymarket anteriores às últimas 24 horas
    try {
      const PredictionArbTrade = (await import('./models/PredictionArbTrade')).default;
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const res = await PredictionArbTrade.deleteMany({ createdAt: { $lt: since24h } });
      if (res.deletedCount && res.deletedCount > 0) {
        console.log(`🧹 [STARTUP] Removidas ${res.deletedCount} operações antigas (>24h) da Polymarket.`);
      }
    } catch (e: any) {
      console.warn('⚠️ [STARTUP] Falha ao limpar operações antigas:', e.message);
    }

    app.listen(PORT, () => {
      console.log(`🚀 [auth-backend] Servidor rodando com sucesso na porta ${PORT}`);
    });

    // Inicializa o loop de monitoramento de alta frequência do Robô Deriv (600ms de intervalo)
    const { runDerivCycle } = await import('./strategy/deriv/deriv-bot');
    setInterval(() => {
      runDerivCycle().catch((err: any) => console.error('⚠️ [DerivBot Loop] Erro:', err.message));
    }, 600);

    // Inicializa o motor do Robô FxPro cTrader
    const { FxProBot } = await import('./strategy/fxpro/fxpro-bot');
    await FxProBot.start();

    // Inicializa o motor do Robô IC Markets cTrader
    const { IcMarketsBot } = await import('./strategy/icmarkets/icmarkets-bot');
    await IcMarketsBot.start();

    // Inicializa o motor do Robô Pepperstone Forex Scalper
    const { startScalper } = await import('./strategy/forex/forex-scalper');
    startScalper().catch((err: any) => console.error('⚠️ [Pepperstone Scalper] Erro:', err.message));
  } catch (err: any) {
    console.error('❌ Falha crítica ao inicializar o servidor de autenticação:', err.message);
    process.exit(1);
  }
})();
