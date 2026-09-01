import { loadEnv } from './utils/env-loader';
loadEnv();

import express from 'express';
import cors from 'cors';
import { connectToDatabase } from './config/db';
import authRoutes from './routes/authRoutes';

const app = express();
const PORT = process.env.PORT || 4002;

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

import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import { join } from 'path';

const swaggerDocument = YAML.load(join(__dirname, '../docs/api/openapi.yaml'));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

import { startTelegramBotAndPM2Monitor } from './utils/telegram';

// Start database connection then start listening
(async () => {
  try {
    await connectToDatabase();
    app.listen(PORT, () => {
      console.log(`🚀 [auth-backend] Servidor rodando com sucesso na porta ${PORT}`);
      startTelegramBotAndPM2Monitor();
    });
  } catch (err: any) {
    console.error('❌ Falha crítica ao inicializar o servidor de autenticação:', err.message);
    process.exit(1);
  }
})();
