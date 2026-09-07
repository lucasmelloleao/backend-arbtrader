# -*- coding: utf-8 -*-
import asyncio
import json
import logging
import math
import os
import time
from typing import Dict, List, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
import websockets
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/TraderProd")
mongo_client = AsyncIOMotorClient(MONGODB_URI)
db = mongo_client.get_database()
configs_collection = db["statarb_configs"]
trades_collection = db["statarb_trades"]

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("StatArbBot")

class BotConfig(BaseModel):
    deriv_token: str = Field("", description="Token API de Autenticacao da Deriv")
    deriv_user_id: str = Field("01a07cf1-da38-7dec-9286-bb113e566ccd", description="User ID da Deriv")
    deriv_app_id: str = Field("1089", description="App ID registrado na Deriv")
    spot_symbol: str = Field("btcusdt", description="Simbolo Spot de referencia (Binance)")
    deriv_symbol: str = Field("R_100", description="Simbolo/Indice ou Ativo na Deriv (ex: R_100, frxBTCUSD)")
    trade_duration_seconds: int = Field(60, description="Duracao do contrato em segundos (ex: 60s)")
    stake_amount: float = Field(10.0, description="Valor base da entrada em USD")
    kelly_fraction: float = Field(0.25, description="Fracao de Kelly para dimensionamento de posicao (0.1 a 1.0)")
    edge_min_threshold: float = Field(0.04, description="Margem minima liquida calculada pelo EDGE (ex: 0.04 = 4%)")
    max_slippage: float = Field(0.01, description="Slippage maximo tolerado (1%)")

class BotStatus(BaseModel):
    is_running: bool
    total_trades: int
    wins: int
    losses: int
    win_rate: float
    total_profit: float
    current_spot_price: float
    bayesian_prob_rise: float
    last_latency_ms: float

from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    await engine.load_from_db()
    yield

app = FastAPI(
    title="StatArb & Latency Arbitrage Engine (Spotter -> Deriv)",
    description="Sistema de arbitragem estatistica e latencia entre mercado Spot e contratos da Deriv com gestao por Kelly Criterion, filtro EDGE e modelo Bayesiano.",
    version="1.0.0",
    lifespan=lifespan
)

@app.get("/api/config", response_model=BotConfig, tags=["Configuracao"])
def get_config():
    return engine.config

@app.post("/api/config", response_model=BotConfig, tags=["Configuracao"])
async def update_config(config: BotConfig):
    engine.config = config
    await engine.save_config_to_db()
    engine.add_log("CONFIG", "Configuracoes do robo atualizadas via API e salvas no MongoDB.")
    return engine.config

@app.get("/api/status", response_model=BotStatus, tags=["Monitoramento"])
def get_status():
    win_rate = (engine.wins / engine.total_trades * 100) if engine.total_trades > 0 else 0.0
    return BotStatus(
        is_running=engine.is_running,
        total_trades=engine.total_trades,
        wins=engine.wins,
        losses=engine.losses,
        win_rate=round(win_rate, 2),
        total_profit=round(engine.total_profit, 2),
        current_spot_price=engine.latest_spot_price,
        bayesian_prob_rise=engine.bayesian_prob_rise,
        last_latency_ms=engine.last_latency_ms
    )

@app.get("/api/trades/open", tags=["Operacoes"])
def get_open_trades():
    return engine.open_trades

@app.get("/api/trades/history", tags=["Operacoes"])
def get_closed_trades():
    return engine.closed_trades

@app.get("/api/logs", tags=["Monitoramento"])
def get_logs():
    return engine.logs

@app.post("/api/bot/start", tags=["Controle"])
async def start_bot():
    engine.start()
    return {"message": "Robo iniciado com sucesso."}

@app.post("/api/bot/stop", tags=["Controle"])
async def stop_bot():
    engine.stop()
    return {"message": "Robo parado com sucesso."}

@app.websocket("/ws/live")
async def websocket_endpoint(websocket: WebSocket):
    await ws_manager.connect(websocket)
    try:
        await websocket.send_json({
            "type": "init",
            "data": {
                "config": engine.config.model_dump(),
                "logs": engine.logs,
                "open_trades": engine.open_trades,
                "closed_trades": engine.closed_trades
            }
        })
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)

class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        for connection in list(self.active_connections):
            try:
                await connection.send_json(message)
            except Exception:
                self.disconnect(connection)

ws_manager = ConnectionManager()

class StatArbEngine:
    def __init__(self):
        self.config = BotConfig()
        self.is_running = False
        self.open_trades: List[Dict] = []
        self.closed_trades: List[Dict] = []
        self.logs: List[Dict] = []
        self.total_trades = 0
        self.wins = 0
        self.losses = 0
        self.total_profit = 0.0
        self.latest_spot_price: float = 0.0
        self.spot_price_history: List[float] = []
        self.bayesian_prob_rise: float = 0.50
        self.last_latency_ms: float = 15.0
        self._task: Optional[asyncio.Task] = None

    async def load_from_db(self):
        try:
            saved_config = await configs_collection.find_one({"_id": "default_config"})
            if saved_config:
                saved_config.pop("_id", None)
                self.config = BotConfig(**saved_config)
                logger.info("Configuracao carregada do MongoDB com sucesso.")
                if self.config.deriv_token:
                    logger.info(f"Token ativo do MongoDB (na integra): [{self.config.deriv_token}]")
                else:
                    logger.info("Nenhum token configurado no MongoDB.")

            saved_trades = await trades_collection.find().to_list(length=1000)
            self.open_trades = []
            self.closed_trades = []
            self.total_trades = 0
            self.wins = 0
            self.losses = 0
            self.total_profit = 0.0

            for trade in saved_trades:
                trade.pop("_id", None)
                if trade.get("status") == "OPEN":
                    # Se o robô foi reiniciado, fecha ordens antigas presas em OPEN como CANCELLED/EXPIRED
                    if time.time() - trade.get("timestamp", 0) > self.config.trade_duration_seconds + 30:
                        trade["status"] = "EXPIRED"
                        trade["profit"] = 0.0
                        self.closed_trades.append(trade)
                        await trades_collection.replace_one({"id": trade["id"]}, trade, upsert=True)
                    else:
                        self.open_trades.append(trade)
                else:
                    self.closed_trades.append(trade)
                    self.total_trades += 1
                    if trade.get("status") == "WON":
                        self.wins += 1
                    elif trade.get("status") == "LOST":
                        self.losses += 1
                    self.total_profit += trade.get("profit", 0.0)

            self.closed_trades.sort(key=lambda x: x.get("timestamp", 0), reverse=True)
            logger.info(f"DB Carregado: {len(self.open_trades)} abertas, {len(self.closed_trades)} fechadas.")
        except Exception as e:
            logger.error(f"Erro ao carregar dados do MongoDB: {e}")

    async def save_config_to_db(self):
        try:
            cfg_dict = self.config.dict()
            await configs_collection.replace_one({"_id": "default_config"}, cfg_dict, upsert=True)
        except Exception as e:
            logger.error(f"Erro ao salvar configuracao no MongoDB: {e}")

    def add_log(self, level: str, message: str):
        log_entry = {"timestamp": time.strftime("%H:%M:%S"), "level": level, "message": message}
        self.logs.append(log_entry)
        if len(self.logs) > 200:
            self.logs.pop(0)
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(ws_manager.broadcast({"type": "log", "data": log_entry}))
        except RuntimeError:
            pass
        logger.info(f"[{level}] {message}")

    async def _binance_spotter_loop(self):
        url = f"wss://stream.binance.com:9443/ws/{self.config.spot_symbol.lower()}@ticker"
        self.add_log("SPOTTER", f"Conectando ao Feed Spot da Binance ({self.config.spot_symbol})...")
        while self.is_running:
            try:
                async with websockets.connect(url) as ws:
                    self.add_log("SPOTTER", "Conexao Spot Binance Estabelecida.")
                    while self.is_running:
                        msg = await ws.recv()
                        data = json.loads(msg)
                        price = float(data.get("c", 0))
                        if price > 0:
                            t0 = time.time()
                            self.latest_spot_price = price
                            self.spot_price_history.append(price)
                            if len(self.spot_price_history) > 50:
                                self.spot_price_history.pop(0)
                            self._update_bayesian_prior()
                            self.last_latency_ms = round((time.time() - t0) * 1000 + 12.5, 2)
                            await ws_manager.broadcast({
                                "type": "ticker",
                                "data": {
                                    "spot_price": self.latest_spot_price,
                                    "prob_rise": self.bayesian_prob_rise,
                                    "latency_ms": self.last_latency_ms
                                }
                            })
                            await self._evaluate_and_execute()
            except Exception as e:
                self.add_log("ERROR", f"Falha no Spotter Binance: {e}. Reconectando em 3s...")
                await asyncio.sleep(3)

    def _update_bayesian_prior(self):
        if len(self.spot_price_history) < 5:
            return
        returns = [(self.spot_price_history[i] - self.spot_price_history[i-1]) / self.spot_price_history[i-1] 
                   for i in range(1, len(self.spot_price_history))]
        recent_momentum = sum(returns[-3:])
        volatility = math.sqrt(sum(r**2 for r in returns[-10:]) / 10) if len(returns) >= 10 else 0.001
        z = (recent_momentum / (volatility + 1e-6))
        prob_rise = 1.0 / (1.0 + math.exp(-z))
        self.bayesian_prob_rise = round(0.7 * self.bayesian_prob_rise + 0.3 * prob_rise, 4)

    async def _evaluate_and_execute(self):
        prob_rise = self.bayesian_prob_rise
        prob_fall = 1.0 - prob_rise
        payout_rate = 0.92
        edge_rise = (prob_rise * payout_rate) - (prob_fall * 1.0) - self.config.max_slippage
        edge_fall = (prob_fall * payout_rate) - (prob_rise * 1.0) - self.config.max_slippage
        
        signal = None
        current_edge = 0.0
        p_win = 0.5
        
        if edge_rise >= self.config.edge_min_threshold:
            signal = "RISE"
            current_edge = edge_rise
            p_win = prob_rise
        elif edge_fall >= self.config.edge_min_threshold:
            signal = "FALL"
            current_edge = edge_fall
            p_win = prob_fall
            
        if not signal:
            return

        b = payout_rate
        p = p_win
        q = 1.0 - p
        f_kelly = (b * p - q) / b
        f_kelly = max(0.0, f_kelly) * self.config.kelly_fraction
        stake = round(max(self.config.stake_amount, self.config.stake_amount * f_kelly * 5), 2)
        
        if len(self.open_trades) >= 2:
            return

        await self._execute_deriv_contract(signal, stake, current_edge)

    async def _execute_deriv_contract(self, direction: str, stake: float, edge: float):
        app_id_clean = self.config.deriv_app_id if str(self.config.deriv_app_id).isdigit() else "1089"
        deriv_url = f"wss://ws.derivws.com/websockets/v3?app_id={app_id_clean}"
        
        real_contract_id = None
        buy_price = stake
        
        # Tentativa de envio da ordem real para a Deriv WebSocket API
        if self.config.deriv_token and self.config.deriv_token != "SEU_TOKEN_DERIV":
            try:
                token_clean = self.config.deriv_token.strip()
                async with websockets.connect(deriv_url) as ws_deriv:
                    # 1. Autenticar Token via JSON payload da Deriv API
                    auth_req = {"authorize": token_clean}
                    await ws_deriv.send(json.dumps(auth_req))
                    auth_res = json.loads(await ws_deriv.recv())
                    
                    if "error" in auth_res:
                        token_used = self.config.deriv_token.strip()
                        err_code = auth_res['error'].get('code', '')
                        err_msg = auth_res['error'].get('message', '')
                        self.add_log("ERROR", f"Erro de Autenticacao Deriv [{err_code}] [Token: '{token_used[:10]}...']: {err_msg}")
                        return
                    
                    self.add_log("DERIV", f"Autenticado com sucesso na Deriv. Conta: {auth_res.get('authorize', {}).get('email')}")
                    currency = auth_res.get("authorize", {}).get("currency", "USD")
                    # 2. Comprar contrato de Opção Binária (CALL/PUT)
                    buy_req = {
                        "buy": 1,
                        "price": stake,
                        "parameters": {
                            "amount": stake,
                            "basis": "stake",
                            "contract_type": contract_type,
                            "currency": currency,
                            "duration": self.config.trade_duration_seconds,
                            "duration_unit": "s",
                            "symbol": self.config.deriv_symbol
                        }
                    }
                    await ws_deriv.send(json.dumps(buy_req))
                    buy_res = json.loads(await ws_deriv.recv())
                    
                    if "error" in buy_res:
                        self.add_log("ERROR", f"Erro ao comprar contrato na Deriv: {buy_res['error'].get('message')}")
                        return
                    
                    real_contract_id = buy_res.get("buy", {}).get("contract_id")
                    buy_price = float(buy_res.get("buy", {}).get("buy_price", stake))
                    self.add_log("DERIV", f"✅ CONTRATO REAL COMPRADO NA DERIV! ID Contrato: {real_contract_id} | Tipo: {contract_type}")
            except Exception as e:
                self.add_log("ERROR", f"Falha na conexao com a API WebSocket da Deriv: {e}")
                return
        else:
            self.add_log("WARNING", "Token da Deriv nao configurado. Insira seu token nas configuracoes.")
            return

        trade_id = f"DRV-{real_contract_id}" if real_contract_id else f"DRV-{int(time.time() * 1000)}"
        trade = {
            "id": trade_id,
            "real_contract_id": real_contract_id,
            "symbol": self.config.deriv_symbol,
            "contract_type": direction,
            "amount": buy_price,
            "entry_tick": self.latest_spot_price,
            "status": "OPEN",
            "payout": round(buy_price * 1.92, 2),
            "profit": 0.0,
            "timestamp": time.time(),
            "edge": round(edge * 100, 2)
        }
        self.open_trades.append(trade)
        self.total_trades += 1
        try:
            await trades_collection.replace_one({"id": trade_id}, trade, upsert=True)
        except Exception as e:
            logger.error(f"Erro ao salvar trade {trade_id} no MongoDB: {e}")
        self.add_log("TAKER", f"Ordem Registrada! ID: {trade_id} | Tipo: {direction} | Stake: {stake} | EDGE: {trade['edge']}%")
        await ws_manager.broadcast({"type": "trade_opened", "data": trade})
        asyncio.create_task(self._resolve_trade_after_delay(trade, self.config.trade_duration_seconds))

    async def _resolve_trade_after_delay(self, trade: Dict, delay: int):
        await asyncio.sleep(delay)
        exit_price = self.latest_spot_price
        won = False
        if trade["contract_type"] == "RISE" and exit_price >= trade["entry_tick"]:
            won = True
        elif trade["contract_type"] == "FALL" and exit_price <= trade["entry_tick"]:
            won = True
            
        if won:
            trade["status"] = "WON"
            trade["profit"] = round(trade["amount"] * 0.92, 2)
            self.wins += 1
            self.total_profit += trade["profit"]
            self.add_log("CLOSER", f"Contrato VENCEDOR [{trade['id']}] +{trade['profit']}")
        else:
            trade["status"] = "LOST"
            trade["profit"] = round(-trade["amount"], 2)
            self.losses += 1
            self.total_profit += trade["profit"]
            self.add_log("CLOSER", f"Contrato PERDEDOR [{trade['id']}] -{abs(trade['profit'])}")

        if trade in self.open_trades:
            self.open_trades.remove(trade)
        self.closed_trades.insert(0, trade)
        try:
            await trades_collection.replace_one({"id": trade["id"]}, trade, upsert=True)
        except Exception as e:
            logger.error(f"Erro ao atualizar trade {trade['id']} no MongoDB: {e}")
        await ws_manager.broadcast({"type": "trade_closed", "data": trade})

    def start(self):
        if not self.is_running:
            self.is_running = True
            self.add_log("SYSTEM", "Iniciando Motor StatArb Engine...")
            self._task = asyncio.create_task(self._binance_spotter_loop())

    def stop(self):
        if self.is_running:
            self.is_running = False
            if self._task:
                self._task.cancel()
            self.add_log("SYSTEM", "Motor StatArb Interrompido.")

engine = StatArbEngine()



@app.get("/api/config", response_model=BotConfig, tags=["Configuracao"])
def get_config():
    return engine.config

@app.post("/api/config", response_model=BotConfig, tags=["Configuracao"])
async def update_config(config: BotConfig):
    config.deriv_token = config.deriv_token.strip()
    engine.config = config
    await engine.save_config_to_db()
    engine.add_log("CONFIG", f"Novo token salvo no MongoDB: [{config.deriv_token[:8]}...{config.deriv_token[-6:]}]")
    return engine.config

@app.get("/api/status", response_model=BotStatus, tags=["Monitoramento"])
def get_status():
    win_rate = (engine.wins / engine.total_trades * 100) if engine.total_trades > 0 else 0.0
    return BotStatus(
        is_running=engine.is_running,
        total_trades=engine.total_trades,
        wins=engine.wins,
        losses=engine.losses,
        win_rate=round(win_rate, 2),
        total_profit=round(engine.total_profit, 2),
        current_spot_price=engine.latest_spot_price,
        bayesian_prob_rise=engine.bayesian_prob_rise,
        last_latency_ms=engine.last_latency_ms
    )

@app.get("/api/trades/open", tags=["Operacoes"])
def get_open_trades():
    return engine.open_trades

@app.delete("/api/trades", tags=["Operacoes"])
async def clear_trades():
    try:
        await trades_collection.delete_many({})
        engine.open_trades.clear()
        engine.closed_trades.clear()
        engine.total_trades = 0
        engine.wins = 0
        engine.losses = 0
        engine.total_profit = 0.0
        engine.add_log("SYSTEM", "Historico de operacoes limpo do MongoDB e da memoria.")
        return {"message": "Operacoes deletadas com sucesso."}
    except Exception as e:
        return {"error": f"Erro ao deletar operacoes: {e}"}

@app.get("/api/logs", tags=["Monitoramento"])
def get_logs():
    return engine.logs

@app.post("/api/bot/start", tags=["Controle"])
async def start_bot():
    engine.start()
    return {"message": "Robo iniciado com sucesso."}

@app.post("/api/bot/stop", tags=["Controle"])
async def stop_bot():
    engine.stop()
    return {"message": "Robo parado com sucesso."}

@app.websocket("/ws/live")
async def websocket_endpoint(websocket: WebSocket):
    await ws_manager.connect(websocket)
    try:
        await websocket.send_json({
            "type": "init",
            "data": {
                "config": engine.config.dict(),
                "logs": engine.logs,
                "open_trades": engine.open_trades,
                "closed_trades": engine.closed_trades
            }
        })
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)

@app.get("/", response_class=HTMLResponse, include_in_schema=False)
def get_dashboard():
    return """
<!DOCTYPE html>
<html lang="pt-BR" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>StatArb Engine - Spotter -> Deriv</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            darkMode: 'class',
            theme: { extend: { colors: { darkbg: '#0F172A', cardbg: '#1E293B', accent: '#3B82F6', success: '#10B981', danger: '#EF4444' } } }
        }
    </script>
</head>
<body class="bg-darkbg text-slate-100 font-sans min-h-screen p-6">
    <div class="max-w-7xl mx-auto space-y-6">
        <header class="flex justify-between items-center bg-cardbg p-5 rounded-xl border border-slate-700 shadow-lg">
            <div>
                <h1 class="text-2xl font-bold text-slate-100 flex items-center gap-2">
                    ⚡ StatArb & Latency Arbitrage
                    <span class="text-xs px-2.5 py-1 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30">Spotter ➔ Deriv</span>
                </h1>
                <p class="text-sm text-slate-400 mt-1">Estrategia de Alta Frequencia baseada em Atualizacao Bayesiana, Edge & Fractional Kelly</p>
            </div>
            <div class="flex items-center gap-4">
                <button onclick="clearTrades()" class="px-4 py-2 bg-rose-600/80 hover:bg-rose-600 rounded-lg text-sm font-medium transition text-white">🗑️ Limpar Operacoes</button>
                <a href="/docs" target="_blank" class="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm font-medium transition">📄 Swagger API Docs</a>
                <button id="btnToggleBot" onclick="toggleBot()" class="px-6 py-2.5 bg-success hover:opacity-90 rounded-lg text-white font-semibold transition shadow-md">▶ Iniciar Robo</button>
            </div>
        </header>
        <div class="grid grid-cols-1 md:grid-cols-5 gap-4">
            <div class="bg-cardbg p-4 rounded-xl border border-slate-700">
                <p class="text-xs text-slate-400 font-medium">Status do Robo</p>
                <div class="flex items-center gap-2 mt-2">
                    <span id="statusIndicator" class="w-3 h-3 rounded-full bg-danger"></span>
                    <span id="statusText" class="text-lg font-bold text-slate-200">Parado</span>
                </div>
            </div>
            <div class="bg-cardbg p-4 rounded-xl border border-slate-700">
                <p class="text-xs text-slate-400 font-medium">Preco Spot (Binance)</p>
                <p id="spotPrice" class="text-xl font-bold text-amber-400 mt-1">.00</p>
            </div>
            <div class="bg-cardbg p-4 rounded-xl border border-slate-700">
                <p class="text-xs text-slate-400 font-medium">Prob. Bayesiana (Rise)</p>
                <p id="probRise" class="text-xl font-bold text-blue-400 mt-1">50.0%</p>
            </div>
            <div class="bg-cardbg p-4 rounded-xl border border-slate-700">
                <p class="text-xs text-slate-400 font-medium">Resultado Acumulado (P&L)</p>
                <p id="totalProfit" class="text-xl font-bold text-slate-200 mt-1">.00</p>
            </div>
            <div class="bg-cardbg p-4 rounded-xl border border-slate-700">
                <p class="text-xs text-slate-400 font-medium">Latencia de Execucao</p>
                <p id="latency" class="text-xl font-bold text-emerald-400 mt-1">-- ms</p>
            </div>
        </div>
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div class="lg:col-span-2 space-y-6">
                <div class="bg-cardbg p-5 rounded-xl border border-slate-700">
                    <h2 class="text-lg font-semibold text-slate-200 mb-3 flex items-center justify-between">
                        <span>🟢 Operacoes Abertas (Deriv)</span>
                        <span id="openCount" class="text-xs bg-slate-700 px-2 py-0.5 rounded-full">0</span>
                    </h2>
                    <div class="overflow-x-auto">
                        <table class="w-full text-left text-sm text-slate-300">
                            <thead class="text-xs uppercase bg-slate-800 text-slate-400">
                                <tr>
                                    <th class="p-3">ID / Contrato</th><th class="p-3">Tipo</th><th class="p-3">Entrada</th><th class="p-3">Stake</th><th class="p-3">Edge</th><th class="p-3">Status</th>
                                </tr>
                            </thead>
                            <tbody id="openTradesTable"><tr><td colspan="6" class="p-4 text-center text-slate-500">Nenhuma operacao aberta no momento.</td></tr></tbody>
                        </table>
                    </div>
                </div>
                <div class="bg-cardbg p-5 rounded-xl border border-slate-700">
                    <h2 class="text-lg font-semibold text-slate-200 mb-3">📜 Historico de Operacoes Encerradas</h2>
                    <div class="overflow-x-auto max-h-72 overflow-y-auto">
                        <table class="w-full text-left text-sm text-slate-300">
                            <thead class="text-xs uppercase bg-slate-800 text-slate-400 sticky top-0">
                                <tr>
                                    <th class="p-3">ID</th><th class="p-3">Tipo</th><th class="p-3">Stake</th><th class="p-3">Resultado</th><th class="p-3">Lucro/Perda</th>
                                </tr>
                            </thead>
                            <tbody id="closedTradesTable"><tr><td colspan="5" class="p-4 text-center text-slate-500">Nenhum historico registrado.</td></tr></tbody>
                        </table>
                    </div>
                </div>
            </div>
            <div class="space-y-6">
                <div class="bg-cardbg p-5 rounded-xl border border-slate-700">
                    <h2 class="text-lg font-semibold text-slate-200 mb-4">⚙️ Configuracoes da Estratégia</h2>
                    <form id="configForm" onsubmit="saveConfig(event)" class="space-y-3">
                        <div>
                            <label class="text-xs text-slate-400">Deriv API Token</label>
                            <input type="password" id="deriv_token" class="w-full bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm mt-1">
                        </div>
                        <div class="grid grid-cols-2 gap-3">
                            <div>
                                <label class="text-xs text-slate-400">Simbolo Spot</label>
                                <input type="text" id="spot_symbol" class="w-full bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm mt-1">
                            </div>
                            <div>
                                <label class="text-xs text-slate-400">Ativo Deriv</label>
                                <input type="text" id="deriv_symbol" class="w-full bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm mt-1">
                            </div>
                        </div>
                        <div class="grid grid-cols-2 gap-3">
                            <div>
                                <label class="text-xs text-slate-400">Stake Base ($)</label>
                                <input type="number" step="0.5" id="stake_amount" class="w-full bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm mt-1">
                            </div>
                            <div>
                                <label class="text-xs text-slate-400">Kelly Fraction</label>
                                <input type="number" step="0.05" id="kelly_fraction" class="w-full bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm mt-1">
                            </div>
                        </div>
                        <div>
                            <label class="text-xs text-slate-400">Edge Minimo Limite (ex: 0.04 = 4%)</label>
                            <input type="number" step="0.01" id="edge_min_threshold" class="w-full bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm mt-1">
                        </div>
                        <button type="submit" class="w-full py-2 bg-blue-600 hover:bg-blue-500 text-white rounded font-medium text-sm transition mt-2">Salvar Parametros</button>
                    </form>
                </div>
                <div class="bg-cardbg p-5 rounded-xl border border-slate-700">
                    <h2 class="text-lg font-semibold text-slate-200 mb-3">💻 Logs do Sistema (Live)</h2>
                    <div id="logConsole" class="bg-slate-950 p-3 rounded-lg font-mono text-xs text-slate-300 h-64 overflow-y-auto space-y-1 border border-slate-800">
                        <div>[SYSTEM] Aguardando conexao...</div>
                    </div>
                </div>
            </div>
        </div>
    </div>
    <script>
        let isRunning = false, ws;
        function connectWS() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(`${protocol}//${window.location.host}/ws/live`);
            ws.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                if (msg.type === 'init') {
                    loadConfig(msg.data.config);
                    msg.data.logs.forEach(appendLog);
                    renderOpenTrades(msg.data.open_trades);
                    renderClosedTrades(msg.data.closed_trades);
                } else if (msg.type === 'ticker') {
                    document.getElementById('spotPrice').innerText = '$' + msg.data.spot_price.toFixed(2);
                    document.getElementById('probRise').innerText = (msg.data.prob_rise * 100).toFixed(1) + '%';
                    document.getElementById('latency').innerText = msg.data.latency_ms + ' ms';
                } else if (msg.type === 'log') appendLog(msg.data);
                else if (msg.type === 'trade_opened' || msg.type === 'trade_closed') fetchStatus();
            };
            ws.onclose = () => setTimeout(connectWS, 2000);
        }
        async function fetchStatus() {
            const res = await fetch('/api/status');
            const data = await res.json();
            isRunning = data.is_running;
            const btn = document.getElementById('btnToggleBot');
            const indicator = document.getElementById('statusIndicator');
            const statusText = document.getElementById('statusText');
            if (isRunning) {
                btn.innerText = '⏸ Parar Robo';
                btn.className = 'px-6 py-2.5 bg-danger hover:opacity-90 rounded-lg text-white font-semibold transition shadow-md';
                indicator.className = 'w-3 h-3 rounded-full bg-success animate-pulse';
                statusText.innerText = 'Executando';
            } else {
                btn.innerText = '▶ Iniciar Robo';
                btn.className = 'px-6 py-2.5 bg-success hover:opacity-90 rounded-lg text-white font-semibold transition shadow-md';
                indicator.className = 'w-3 h-3 rounded-full bg-danger';
                statusText.innerText = 'Parado';
            }
            const pnl = document.getElementById('totalProfit');
            pnl.innerText = (data.total_profit >= 0 ? '+' : '') + '$' + data.total_profit.toFixed(2);
            pnl.className = 'text-xl font-bold mt-1 ' + (data.total_profit >= 0 ? 'text-emerald-400' : 'text-rose-500');
            const openRes = await fetch('/api/trades/open');
            renderOpenTrades(await openRes.json());
            const closedRes = await fetch('/api/trades/history');
            renderClosedTrades(await closedRes.json());
        }
        async function toggleBot() {
            try {
                const endpoint = isRunning ? '/api/bot/stop' : '/api/bot/start';
                const res = await fetch(endpoint, { method: 'POST' });
                if (!res.ok) {
                    alert('Erro ao alterar status do robo: ' + res.statusText);
                }
                await fetchStatus();
            } catch (err) {
                console.error(err);
                alert('Erro ao se comunicar com a API do robo.');
            }
        }
        async function clearTrades() {
            if (confirm('Tem certeza que deseja apagar todo o historico de operacoes abertas e encerradas do MongoDB?')) {
                try {
                    await fetch('/api/trades', { method: 'DELETE' });
                    fetchStatus();
                } catch (err) {
                    console.error(err);
                    alert('Erro ao limpar operacoes.');
                }
            }
        }
        function loadConfig(config) {
            document.getElementById('deriv_token').value = config.deriv_token;
            document.getElementById('spot_symbol').value = config.spot_symbol;
            document.getElementById('deriv_symbol').value = config.deriv_symbol;
            document.getElementById('stake_amount').value = config.stake_amount;
            document.getElementById('kelly_fraction').value = config.kelly_fraction;
            document.getElementById('edge_min_threshold').value = config.edge_min_threshold;
        }
        async function saveConfig(e) {
            e.preventDefault();
            const config = {
                deriv_token: document.getElementById('deriv_token').value.trim(),
                deriv_user_id: "01a07cf1-da38-7dec-9286-bb113e566ccd",
                deriv_app_id: "1089",
                spot_symbol: document.getElementById('spot_symbol').value.trim(),
                deriv_symbol: document.getElementById('deriv_symbol').value.trim(),
                trade_duration_seconds: 60,
                stake_amount: parseFloat(document.getElementById('stake_amount').value),
                kelly_fraction: parseFloat(document.getElementById('kelly_fraction').value),
                edge_min_threshold: parseFloat(document.getElementById('edge_min_threshold').value),
                max_slippage: 0.01
            };
            await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
            alert('Configuracoes salvas com sucesso!');
        }
        function appendLog(log) {
            const consoleEl = document.getElementById('logConsole');
            const div = document.createElement('div');
            let color = 'text-slate-300';
            if (log.level === 'TAKER') color = 'text-blue-400 font-semibold';
            if (log.level === 'CLOSER') color = 'text-emerald-400 font-semibold';
            if (log.level === 'ERROR') color = 'text-rose-400 font-semibold';
            if (log.level === 'SPOTTER') color = 'text-amber-400';
            div.className = color;
            div.innerText = `[${log.timestamp}] [${log.level}] ${log.message}`;
            consoleEl.appendChild(div);
            consoleEl.scrollTop = consoleEl.scrollHeight;
        }
        function renderOpenTrades(trades) {
            document.getElementById('openCount').innerText = trades.length;
            const tbody = document.getElementById('openTradesTable');
            if (trades.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" class="p-4 text-center text-slate-500">Nenhuma operacao aberta no momento.</td></tr>';
                return;
            }
            tbody.innerHTML = trades.map(t => `
                <tr class="border-b border-slate-800 hover:bg-slate-800/50">
                    <td class="p-3 font-mono text-xs">${t.id}<br><span class="text-slate-400">${t.symbol}</span></td>
                    <td class="p-3 font-bold ${t.contract_type === 'RISE' ? 'text-emerald-400' : 'text-rose-400'}">${t.contract_type}</td>
                    <td class="p-3">$${t.entry_tick.toFixed(2)}</td>
                    <td class="p-3">$${t.amount.toFixed(2)}</td>
                    <td class="p-3 text-blue-400 font-semibold">${t.edge}%</td>
                    <td class="p-3"><span class="px-2 py-0.5 rounded bg-blue-500/20 text-blue-400 text-xs font-semibold">EM ANDAMENTO</span></td>
                </tr>
            `).join('');
        }
        function renderClosedTrades(trades) {
            const tbody = document.getElementById('closedTradesTable');
            if (trades.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-slate-500">Nenhum historico registrado.</td></tr>';
                return;
            }
            tbody.innerHTML = trades.map(t => `
                <tr class="border-b border-slate-800 hover:bg-slate-800/50">
                    <td class="p-3 font-mono text-xs">${t.id}</td>
                    <td class="p-3 font-bold ${t.contract_type === 'RISE' ? 'text-emerald-400' : 'text-rose-400'}">${t.contract_type}</td>
                    <td class="p-3">$${t.amount.toFixed(2)}</td>
                    <td class="p-3 font-semibold ${t.status === 'WON' ? 'text-emerald-400' : 'text-rose-400'}">${t.status}</td>
                    <td class="p-3 font-semibold ${t.profit >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${t.profit >= 0 ? '+' : ''}$${t.profit.toFixed(2)}</td>
                </tr>
            `).join('');
        }
        connectWS();
        fetchStatus();
    </script>
</body>
</html>
    """

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)