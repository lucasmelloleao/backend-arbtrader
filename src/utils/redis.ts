import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL;

const redis = redisUrl ? new Redis(redisUrl, { maxRetriesPerRequest: null }) : null;

if (redis) {
  redis.on('error', (err) => {
    console.error(`[REDIS ERROR] Conexão falhou no Backend: ${err.message}`);
  });
}

if (!redis) {
  console.warn('⚠️ REDIS_URL não configurada no .env. Eventos Pub/Sub não serão disparados.');
}

export default redis;
