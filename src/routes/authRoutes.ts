import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import {
  login,
  logout,
  register,
  google,
  forgotPassword,
  resetPassword,
  changePassword,
  getMe,
  updateMe,
  generate2FA,
  verify2FA,
  disable2FA
} from '../controllers/authController';
import {
  getExchanges,
  createExchange,
  updateExchange,
  deleteExchange
} from '../controllers/exchangeController';
import {
  savePolymarketCredentials,
  syncPolymarketBalance,
  transferPusdToDepositWallet,
  deployDepositWallet,
  syncPredictionHistoryController
} from '../controllers/polymarketController';
import {
  getStrategies,
  createStrategy,
  updateStrategy,
  deleteStrategy,
  getTrades,
  deleteTrades,
  getTradesSummary
} from '../controllers/perpArbController';
import {
  getPortfolioResumo,
  getPortfolioHistorico,
  getPortfolioLive
} from '../controllers/portfolioController';
import {
  getUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser
} from '../controllers/userMaintenanceController';
import {
  getPerpArbSettings,
  updatePerpArbSettings,
  getBotStatus
} from '../controllers/perpArbSettingsController';
import {
  getLatencySettings,
  updateLatencySettings,
  getLatencyTrades,
  closeLatencyTrade,
  getLatencyLogs
} from '../controllers/latencyArbController';
import {
  closeStrategy as closePerpStrategy,
  increaseStrategy as increasePerpStrategy,
  voidCloseStrategy as voidClosePerpStrategy,
  getLogs as getPerpLogs,
  manualScan,
  auditExchangeTrades
} from '../controllers/perpArbOperationsController';

import {
  getForexStrategies,
  createForexStrategy,
  deleteForexStrategy,
  getForexTrades,
  deleteForexTrades,
  getForexOpportunities,
  getForexSettings,
  updateForexSettings,
  updateCtraderCredentials,
  closeForexStrategy,
  voidCloseForexStrategy,
  closeAllForexStrategies,
  getForexLogs,
  getForexLivePrices
} from '../controllers/forexArbController';
import {
  getPredictionStrategies,
  createPredictionStrategy,
  updatePredictionStrategy,
  deletePredictionStrategy,
  getPredictionTrades,
  getPredictionTradesSummary,
  deletePredictionTrades
} from '../controllers/predictionArbController';
import {
  getPredictionArbSettings,
  updatePredictionArbSettings,
  getPredictionBotStatus
} from '../controllers/predictionArbSettingsController';
import {
  closePredictionStrategy,
  increasePredictionStrategy,
  voidClosePredictionStrategy,
  manualScanPrediction,
  getPredictionLogs
} from '../controllers/predictionArbOperationsController';

const router = Router();

// --- NEW FRONTEND ENDPOINTS (direct API v1) ---
router.post('/login', login as any);
router.post('/logout', logout as any);
router.get('/perfil', authMiddleware as any, getMe as any);
router.put('/perfil', authMiddleware as any, updateMe as any);
router.put('/perfil/senha', authMiddleware as any, changePassword as any);
router.post('/perfil/2fa/gerar', authMiddleware as any, generate2FA as any);
router.post('/perfil/2fa/ativar', authMiddleware as any, verify2FA as any);
router.post('/perfil/2fa/desativar', authMiddleware as any, disable2FA as any);

router.get('/exchanges', authMiddleware as any, getExchanges as any);
router.post('/exchanges', authMiddleware as any, createExchange as any);
router.put('/exchanges', authMiddleware as any, updateExchange as any);
router.delete('/exchanges', authMiddleware as any, deleteExchange as any);
router.post('/polymarket/credentials', authMiddleware as any, savePolymarketCredentials as any);
router.get('/polymarket/balance', authMiddleware as any, syncPolymarketBalance as any);
router.post('/polymarket/transfer', authMiddleware as any, transferPusdToDepositWallet as any);
router.post('/polymarket/deploy-wallet', authMiddleware as any, deployDepositWallet as any);
router.post('/polymarket/sync-history', authMiddleware as any, syncPredictionHistoryController as any);

router.get('/perp-arb/strategies', authMiddleware as any, getStrategies as any);
router.post('/perp-arb/strategies', authMiddleware as any, createStrategy as any);
router.put('/perp-arb/strategies', authMiddleware as any, updateStrategy as any);
router.delete('/perp-arb/strategies/:id', authMiddleware as any, deleteStrategy as any);
router.delete('/perp-arb/strategies', authMiddleware as any, deleteStrategy as any);
router.get('/perp-arb/trades', authMiddleware as any, getTrades as any);
router.get('/perp-arb/trades/resumo', authMiddleware as any, getTradesSummary as any);
router.delete('/perp-arb/trades', authMiddleware as any, deleteTrades as any);
router.get('/perp-arb/settings', authMiddleware as any, getPerpArbSettings as any);
router.post('/perp-arb/settings', authMiddleware as any, updatePerpArbSettings as any);
router.post('/perp-arb/close', authMiddleware as any, closePerpStrategy as any);
router.post('/perp-arb/increase', authMiddleware as any, increasePerpStrategy as any);
router.post('/perp-arb/void-close', authMiddleware as any, voidClosePerpStrategy as any);
router.get('/perp-arb/logs', authMiddleware as any, getPerpLogs as any);
router.get('/perp-arb/manual-scan', authMiddleware as any, manualScan as any);
router.get('/perp-arb/audit-exchange', authMiddleware as any, auditExchangeTrades as any);

// --- FOREX ARB ENDPOINTS ---
router.get('/forex-arb/strategies', authMiddleware as any, getForexStrategies as any);
router.post('/forex-arb/strategies', authMiddleware as any, createForexStrategy as any);
router.delete('/forex-arb/strategies', authMiddleware as any, deleteForexStrategy as any);
router.delete('/forex-arb/strategies/:id', authMiddleware as any, deleteForexStrategy as any);
router.get('/forex-arb/trades', authMiddleware as any, getForexTrades as any);
router.delete('/forex-arb/trades', authMiddleware as any, deleteForexTrades as any);
router.get('/forex-arb/opportunities', authMiddleware as any, getForexOpportunities as any);
router.get('/forex-arb/settings', authMiddleware as any, getForexSettings as any);
router.post('/forex-arb/settings', authMiddleware as any, updateForexSettings as any);
router.put('/forex-arb/ctrader-credentials', authMiddleware as any, updateCtraderCredentials as any);
router.post('/forex-arb/close', authMiddleware as any, closeForexStrategy as any);
router.post('/forex-arb/void-close', authMiddleware as any, voidCloseForexStrategy as any);
router.post('/forex-arb/close-all', authMiddleware as any, closeAllForexStrategies as any);
router.get('/forex-arb/logs', authMiddleware as any, getForexLogs as any);
router.get('/forex-arb/live-prices', authMiddleware as any, getForexLivePrices as any);

router.get('/bot-status', authMiddleware as any, getBotStatus as any);
router.get('/auth/bot-status', authMiddleware as any, getBotStatus as any);
router.get('/auth/perp-arb-settings', authMiddleware as any, getPerpArbSettings as any);
router.post('/auth/perp-arb-settings', authMiddleware as any, updatePerpArbSettings as any);


// --- PREDICTION ARB DASHBOARD ENDPOINTS ---
router.get('/prediction-arb/strategies', authMiddleware as any, getPredictionStrategies as any);
router.post('/prediction-arb/strategies', authMiddleware as any, createPredictionStrategy as any);
router.put('/prediction-arb/strategies', authMiddleware as any, updatePredictionStrategy as any);
router.delete('/prediction-arb/strategies/:id', authMiddleware as any, deletePredictionStrategy as any);
router.delete('/prediction-arb/strategies', authMiddleware as any, deletePredictionStrategy as any);
router.get('/prediction-arb/trades', authMiddleware as any, getPredictionTrades as any);
router.delete('/prediction-arb/trades', authMiddleware as any, deletePredictionTrades as any);
router.get('/prediction-arb/trades/resumo', authMiddleware as any, getPredictionTradesSummary as any);
router.get('/prediction-arb/settings', authMiddleware as any, getPredictionArbSettings as any);
router.post('/prediction-arb/settings', authMiddleware as any, updatePredictionArbSettings as any);
router.get('/prediction-arb/bot-status', authMiddleware as any, getPredictionBotStatus as any);
router.post('/prediction-arb/close', authMiddleware as any, closePredictionStrategy as any);
router.post('/prediction-arb/increase', authMiddleware as any, increasePredictionStrategy as any);
router.post('/prediction-arb/void-close', authMiddleware as any, voidClosePredictionStrategy as any);
router.get('/prediction-arb/manual-scan', authMiddleware as any, manualScanPrediction as any);
router.get('/prediction-arb/logs', authMiddleware as any, getPredictionLogs as any);

router.get('/auth/prediction-arb/strategies', authMiddleware as any, getPredictionStrategies as any);
router.post('/auth/prediction-arb/strategies', authMiddleware as any, createPredictionStrategy as any);
router.put('/auth/prediction-arb/strategies', authMiddleware as any, updatePredictionStrategy as any);
router.delete('/auth/prediction-arb/strategies/:id', authMiddleware as any, deletePredictionStrategy as any);
router.delete('/auth/prediction-arb/strategies', authMiddleware as any, deletePredictionStrategy as any);
router.get('/auth/prediction-arb/trades', authMiddleware as any, getPredictionTrades as any);
router.delete('/auth/prediction-arb/trades', authMiddleware as any, deletePredictionTrades as any);
router.get('/auth/prediction-arb/trades/resumo', authMiddleware as any, getPredictionTradesSummary as any);
router.get('/auth/prediction-arb/settings', authMiddleware as any, getPredictionArbSettings as any);
router.post('/auth/prediction-arb/settings', authMiddleware as any, updatePredictionArbSettings as any);
router.get('/auth/prediction-arb/bot-status', authMiddleware as any, getPredictionBotStatus as any);
router.post('/auth/prediction-arb/close', authMiddleware as any, closePredictionStrategy as any);
router.post('/auth/prediction-arb/increase', authMiddleware as any, increasePredictionStrategy as any);
router.post('/auth/prediction-arb/void-close', authMiddleware as any, voidClosePredictionStrategy as any);
router.get('/auth/prediction-arb/manual-scan', authMiddleware as any, manualScanPrediction as any);
router.get('/auth/prediction-arb/logs', authMiddleware as any, getPredictionLogs as any);

router.get('/portfolio/resumo', authMiddleware as any, getPortfolioResumo as any);
router.get('/portfolio/historico', authMiddleware as any, getPortfolioHistorico as any);
router.get('/portfolio/live', authMiddleware as any, getPortfolioLive as any);

router.get('/auth/portfolio/resumo', authMiddleware as any, getPortfolioResumo as any);
router.get('/auth/portfolio/historico', authMiddleware as any, getPortfolioHistorico as any);
router.get('/auth/portfolio/live', authMiddleware as any, getPortfolioLive as any);

import { consultarProcessoTJPR } from '../controllers/processLookupController';

// --- LATENCY ARB ENDPOINTS ---
router.get('/latency-arb/settings', authMiddleware as any, getLatencySettings as any);
router.post('/latency-arb/settings', authMiddleware as any, updateLatencySettings as any);
router.get('/latency-arb/trades', authMiddleware as any, getLatencyTrades as any);
router.post('/latency-arb/close', authMiddleware as any, closeLatencyTrade as any);
router.get('/latency-arb/logs', authMiddleware as any, getLatencyLogs as any);

router.get('/auth/latency-arb/settings', authMiddleware as any, getLatencySettings as any);
router.post('/auth/latency-arb/settings', authMiddleware as any, updateLatencySettings as any);
router.get('/auth/latency-arb/trades', authMiddleware as any, getLatencyTrades as any);
router.post('/auth/latency-arb/close', authMiddleware as any, closeLatencyTrade as any);
router.get('/auth/latency-arb/logs', authMiddleware as any, getLatencyLogs as any);

// --- CONSULTA PROCESSUAL TJPR / DATAJUD ---
router.post('/processo-tjpr', authMiddleware as any, consultarProcessoTJPR as any);
router.post('/auth/processo-tjpr', authMiddleware as any, consultarProcessoTJPR as any);

// --- DERIV BOT ENDPOINTS ---
import {
  getDerivSettings,
  updateDerivSettings,
  getDerivTrades,
  deleteDerivTrades,
  getDerivTradesSummary,
  getDerivBalance,
  getDerivLogs,
  getDerivStrategies,
  createDerivStrategy,
  updateDerivStrategy,
  deleteDerivStrategy,
  getDerivContractsFor,
  testDerivProposal
} from '../controllers/derivController';

router.get('/deriv/settings', authMiddleware as any, getDerivSettings as any);
router.post('/deriv/settings', authMiddleware as any, updateDerivSettings as any);
router.get('/deriv/strategies', authMiddleware as any, getDerivStrategies as any);
router.post('/deriv/strategies', authMiddleware as any, createDerivStrategy as any);
router.put('/deriv/strategies/:id', authMiddleware as any, updateDerivStrategy as any);
router.delete('/deriv/strategies/:id', authMiddleware as any, deleteDerivStrategy as any);
router.get('/deriv/contracts-for', authMiddleware as any, getDerivContractsFor as any);
router.post('/deriv/proposal', authMiddleware as any, testDerivProposal as any);
router.get('/deriv/trades', authMiddleware as any, getDerivTrades as any);
router.delete('/deriv/trades', authMiddleware as any, deleteDerivTrades as any);
router.get('/deriv/trades/summary', authMiddleware as any, getDerivTradesSummary as any);
router.get('/deriv/balance', authMiddleware as any, getDerivBalance as any);
router.get('/deriv/logs', authMiddleware as any, getDerivLogs as any);

router.get('/auth/deriv/settings', authMiddleware as any, getDerivSettings as any);
router.post('/auth/deriv/settings', authMiddleware as any, updateDerivSettings as any);
router.get('/auth/deriv/strategies', authMiddleware as any, getDerivStrategies as any);
router.post('/auth/deriv/strategies', authMiddleware as any, createDerivStrategy as any);
router.put('/auth/deriv/strategies/:id', authMiddleware as any, updateDerivStrategy as any);
router.delete('/auth/deriv/strategies/:id', authMiddleware as any, deleteDerivStrategy as any);
router.get('/auth/deriv/contracts-for', authMiddleware as any, getDerivContractsFor as any);
router.post('/auth/deriv/proposal', authMiddleware as any, testDerivProposal as any);
router.get('/auth/deriv/trades', authMiddleware as any, getDerivTrades as any);
router.delete('/auth/deriv/trades', authMiddleware as any, deleteDerivTrades as any);
router.get('/auth/deriv/trades/summary', authMiddleware as any, getDerivTradesSummary as any);
router.get('/auth/deriv/balance', authMiddleware as any, getDerivBalance as any);
router.get('/auth/deriv/logs', authMiddleware as any, getDerivLogs as any);

export default router;
