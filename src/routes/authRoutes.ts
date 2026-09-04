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
  closeStrategy,
  increaseStrategy,
  voidCloseStrategy,
  getLogs,
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
  closeAllForexStrategies,
  getForexLogs
} from '../controllers/forexArbController';
import {
  getPredictionStrategies,
  createPredictionStrategy,
  updatePredictionStrategy,
  deletePredictionStrategy,
  getPredictionTrades,
  getPredictionTradesSummary
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
  manualScanPrediction
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
router.get('/forex-arb/logs', authMiddleware as any, getForexLogs as any);

router.get('/bot-status', authMiddleware as any, getBotStatus as any);
router.get('/perp-arb/settings', authMiddleware as any, getPerpArbSettings as any);
router.post('/perp-arb/settings', authMiddleware as any, updatePerpArbSettings as any);
router.post('/perp-arb/close', authMiddleware as any, closeStrategy as any);
router.post('/perp-arb/increase', authMiddleware as any, increaseStrategy as any);
router.post('/perp-arb/void-close', authMiddleware as any, voidCloseStrategy as any);
router.get('/perp-arb/logs', authMiddleware as any, getLogs as any);
router.get('/perp-arb/manual-scan', authMiddleware as any, manualScan as any);
router.get('/perp-arb/audit-exchange', authMiddleware as any, auditExchangeTrades as any);

// --- PREDICTION ARB ENDPOINTS ---
router.get('/prediction-arb/strategies', authMiddleware as any, getPredictionStrategies as any);
router.post('/prediction-arb/strategies', authMiddleware as any, createPredictionStrategy as any);
router.put('/prediction-arb/strategies', authMiddleware as any, updatePredictionStrategy as any);
router.delete('/prediction-arb/strategies/:id', authMiddleware as any, deletePredictionStrategy as any);
router.delete('/prediction-arb/strategies', authMiddleware as any, deletePredictionStrategy as any);
router.get('/prediction-arb/trades', authMiddleware as any, getPredictionTrades as any);
router.get('/prediction-arb/trades/resumo', authMiddleware as any, getPredictionTradesSummary as any);
router.get('/prediction-arb/settings', authMiddleware as any, getPredictionArbSettings as any);
router.post('/prediction-arb/settings', authMiddleware as any, updatePredictionArbSettings as any);
router.get('/prediction-arb/bot-status', authMiddleware as any, getPredictionBotStatus as any);
router.post('/prediction-arb/close', authMiddleware as any, closePredictionStrategy as any);
router.post('/prediction-arb/increase', authMiddleware as any, increasePredictionStrategy as any);
router.post('/prediction-arb/void-close', authMiddleware as any, voidClosePredictionStrategy as any);
router.get('/prediction-arb/manual-scan', authMiddleware as any, manualScanPrediction as any);

router.get('/portfolio/resumo', authMiddleware as any, getPortfolioResumo as any);
router.get('/portfolio/historico', authMiddleware as any, getPortfolioHistorico as any);
router.get('/portfolio/live', authMiddleware as any, getPortfolioLive as any);

router.get('/usuarios', authMiddleware as any, getUsers as any);
router.get('/usuarios/:id', authMiddleware as any, getUserById as any);
router.post('/usuarios', authMiddleware as any, createUser as any);
router.put('/usuarios/:id', authMiddleware as any, updateUser as any);
router.delete('/usuarios/:id', authMiddleware as any, deleteUser as any);

// --- DASHBOARD ENDPOINTS (for proxy/backward compatibility) ---
router.post('/auth/login', login as any);
router.post('/auth/register', register as any);
router.post('/auth/google', google as any);
router.post('/auth/forgot-password', forgotPassword as any);
router.post('/auth/reset-password', resetPassword as any);
router.post('/auth/change-password', authMiddleware as any, changePassword as any);
router.get('/auth/me', authMiddleware as any, getMe as any);
router.put('/auth/me', authMiddleware as any, updateMe as any);
router.post('/auth/2fa/generate', authMiddleware as any, generate2FA as any);
router.post('/auth/2fa/verify', authMiddleware as any, verify2FA as any);
router.post('/auth/2fa/disable', authMiddleware as any, disable2FA as any);

router.get('/auth/exchanges', authMiddleware as any, getExchanges as any);
router.post('/auth/exchanges', authMiddleware as any, createExchange as any);
router.put('/auth/exchanges', authMiddleware as any, updateExchange as any);
router.delete('/auth/exchanges', authMiddleware as any, deleteExchange as any);
router.post('/auth/polymarket/credentials', authMiddleware as any, savePolymarketCredentials as any);
router.get('/auth/polymarket/balance', authMiddleware as any, syncPolymarketBalance as any);
router.post('/auth/polymarket/transfer', authMiddleware as any, transferPusdToDepositWallet as any);
router.post('/auth/polymarket/deploy-wallet', authMiddleware as any, deployDepositWallet as any);
router.post('/auth/polymarket/sync-history', authMiddleware as any, syncPredictionHistoryController as any);

router.get('/auth/perp-arb/strategies', authMiddleware as any, getStrategies as any);
router.post('/auth/perp-arb/strategies', authMiddleware as any, createStrategy as any);
router.put('/auth/perp-arb/strategies', authMiddleware as any, updateStrategy as any);
router.delete('/auth/perp-arb/strategies/:id', authMiddleware as any, deleteStrategy as any);
router.delete('/auth/perp-arb/strategies', authMiddleware as any, deleteStrategy as any);
router.get('/auth/perp-arb/trades', authMiddleware as any, getTrades as any);
router.get('/auth/perp-arb/trades/resumo', authMiddleware as any, getTradesSummary as any);
router.delete('/auth/perp-arb/trades', authMiddleware as any, deleteTrades as any);

router.get('/auth/forex-arb/strategies', authMiddleware as any, getForexStrategies as any);
router.post('/auth/forex-arb/strategies', authMiddleware as any, createForexStrategy as any);
router.delete('/auth/forex-arb/strategies', authMiddleware as any, deleteForexStrategy as any);
router.delete('/auth/forex-arb/strategies/:id', authMiddleware as any, deleteForexStrategy as any);
router.get('/auth/forex-arb/trades', authMiddleware as any, getForexTrades as any);
router.get('/auth/forex-arb/opportunities', authMiddleware as any, getForexOpportunities as any);
router.get('/auth/forex-arb/settings', authMiddleware as any, getForexSettings as any);
router.post('/auth/forex-arb/settings', authMiddleware as any, updateForexSettings as any);
router.put('/auth/forex-arb/ctrader-credentials', authMiddleware as any, updateCtraderCredentials as any);
router.post('/auth/forex-arb/close', authMiddleware as any, closeForexStrategy as any);
router.post('/auth/forex-arb/close-all', authMiddleware as any, closeAllForexStrategies as any);
router.get('/auth/forex-arb/logs', authMiddleware as any, getForexLogs as any);

router.get('/auth/bot-status', authMiddleware as any, getBotStatus as any);
router.get('/auth/perp-arb-settings', authMiddleware as any, getPerpArbSettings as any);
router.post('/auth/perp-arb-settings', authMiddleware as any, updatePerpArbSettings as any);
router.post('/auth/perp-arb/close', authMiddleware as any, closeStrategy as any);
router.post('/auth/perp-arb/increase', authMiddleware as any, increaseStrategy as any);
router.post('/auth/perp-arb/void-close', authMiddleware as any, voidCloseStrategy as any);
router.get('/auth/perp-arb/logs', authMiddleware as any, getLogs as any);
router.get('/auth/perp-arb/manual-scan', authMiddleware as any, manualScan as any);
router.get('/auth/perp-arb/audit-exchange', authMiddleware as any, auditExchangeTrades as any);

// --- PREDICTION ARB DASHBOARD ENDPOINTS ---
router.get('/auth/prediction-arb/strategies', authMiddleware as any, getPredictionStrategies as any);
router.post('/auth/prediction-arb/strategies', authMiddleware as any, createPredictionStrategy as any);
router.put('/auth/prediction-arb/strategies', authMiddleware as any, updatePredictionStrategy as any);
router.delete('/auth/prediction-arb/strategies/:id', authMiddleware as any, deletePredictionStrategy as any);
router.delete('/auth/prediction-arb/strategies', authMiddleware as any, deletePredictionStrategy as any);
router.get('/auth/prediction-arb/trades', authMiddleware as any, getPredictionTrades as any);
router.get('/auth/prediction-arb/trades/resumo', authMiddleware as any, getPredictionTradesSummary as any);
router.get('/auth/prediction-arb/settings', authMiddleware as any, getPredictionArbSettings as any);
router.post('/auth/prediction-arb/settings', authMiddleware as any, updatePredictionArbSettings as any);
router.get('/auth/prediction-arb/bot-status', authMiddleware as any, getPredictionBotStatus as any);
router.post('/auth/prediction-arb/close', authMiddleware as any, closePredictionStrategy as any);
router.post('/auth/prediction-arb/increase', authMiddleware as any, increasePredictionStrategy as any);
router.post('/auth/prediction-arb/void-close', authMiddleware as any, voidClosePredictionStrategy as any);
router.get('/auth/prediction-arb/manual-scan', authMiddleware as any, manualScanPrediction as any);

router.get('/auth/portfolio/resumo', authMiddleware as any, getPortfolioResumo as any);
router.get('/auth/portfolio/historico', authMiddleware as any, getPortfolioHistorico as any);
router.get('/auth/portfolio/live', authMiddleware as any, getPortfolioLive as any);

router.get('/auth/usuarios', authMiddleware as any, getUsers as any);
router.get('/auth/usuarios/:id', authMiddleware as any, getUserById as any);
router.post('/auth/usuarios', authMiddleware as any, createUser as any);
router.put('/auth/usuarios/:id', authMiddleware as any, updateUser as any);
router.delete('/auth/usuarios/:id', authMiddleware as any, deleteUser as any);

export default router;
