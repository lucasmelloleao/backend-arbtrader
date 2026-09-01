// DukascopyBridge — middleware Java: conecta ao JForex SDK via uma IStrategy
// interna (padrão oficial do SDK) e expõe HTTP para o robô Node.
//
// Endpoints:
//   POST /connect   { jnlpUrl, username, password }  → conecta e inicia a strategy
//   GET  /markets                                    → lista instrumentos forex
//   GET  /tickers?symbols=EUR/USD,GBP/USD            → bid/ask atuais
//   GET  /ticker?symbol=EUR/USD                      → bid/ask de um símbolo
//   POST /order      { symbol, side, amount }        → ordem MARKET
//   GET  /positions                                  → posições abertas (com PnL)
//   GET  /account                                    → saldo/equity
//   GET  /health                                     → status
//
// Uso: java -cp "<jars>;out" bridge.DukascopyBridge [porta]
package bridge;

import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpExchange;
import com.dukascopy.api.*;
import com.dukascopy.api.system.ClientFactory;
import com.dukascopy.api.system.IClient;
import com.dukascopy.api.system.ISystemListener;

import java.io.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

public class DukascopyBridge {

    private static IClient client;
    private static volatile IContext context;
    private static final AtomicBoolean connected = new AtomicBoolean(false);
    private static final Map<String, double[]> lastTicks = new ConcurrentHashMap<>(); // symbol -> {bid, ask}
    private static final Map<String, Integer> symbolDigits = new ConcurrentHashMap<>();

    // Fila de comandos de ordem (symbol, side, amount) — executados na thread da strategy
    private static final BlockingQueue<OrderRequest> orderQueue = new LinkedBlockingQueue<>();
    private static final Map<String, IOrder> submittedOrders = new ConcurrentHashMap<>();

    private static volatile String jnlpUrl = "http://platform.dukascopy.com/demo_3/jforex_3.jnlp";
    private static volatile String username = "";
    private static volatile String password = "";

    public static void main(String[] args) throws Exception {
        int port = args.length > 0 ? Integer.parseInt(args[0]) : 9100;
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        server.createContext("/connect", DukascopyBridge::handleConnect);
        server.createContext("/markets", DukascopyBridge::handleMarkets);
        server.createContext("/tickers", DukascopyBridge::handleTickers);
        server.createContext("/ticker", DukascopyBridge::handleTicker);
        server.createContext("/order", DukascopyBridge::handleOrder);
        server.createContext("/positions", DukascopyBridge::handlePositions);
        server.createContext("/account", DukascopyBridge::handleAccount);
        server.createContext("/health", DukascopyBridge::handleHealth);
        server.setExecutor(Executors.newFixedThreadPool(8));
        server.start();
        System.out.println("[DukascopyBridge] HTTP ouvindo em 127.0.0.1:" + port);
    }

    // ─── Strategy interna (roda dentro do SDK) ─────────────────────────────────

    private static class BridgeStrategy implements IStrategy {
        @Override public void onStart(IContext ctx) throws JFException {
            context = ctx;
            ctx.setSubscribedInstruments(getForexInstruments());
            System.out.println("[DukascopyBridge] Strategy iniciada, instrumentos assinados: " + ctx.getSubscribedInstruments().size());
            // Consome a fila de ordens
            new Thread(() -> {
                while (true) {
                    try {
                        OrderRequest req = orderQueue.take();
                        try {
                            IEngine engine = ctx.getEngine();
                            Instrument inst = Instrument.valueOf(req.symbol);
                            IEngine.OrderCommand cmd = "sell".equals(req.side) ? IEngine.OrderCommand.SELL : IEngine.OrderCommand.BUY;
                            IOrder order = engine.submitOrder("fa_" + System.currentTimeMillis(), inst, cmd, req.amount);
                            submittedOrders.put(order.getId(), order);
                            req.result.complete(order);
                        } catch (Exception e) {
                            req.result.completeExceptionally(e);
                        }
                    } catch (InterruptedException e) {
                        return;
                    }
                }
            }).start();
        }

        @Override
        public void onTick(Instrument instrument, ITick tick) throws JFException {
            lastTicks.put(instrument.name(), new double[]{ tick.getBid(), tick.getAsk() });
        }

        @Override public void onBar(Instrument instrument, Period period, IBar askBar, IBar bidBar) throws JFException {}
        @Override public void onMessage(IMessage message) throws JFException {}
        @Override public void onAccount(IAccount account) throws JFException {}
        @Override public void onStop() throws JFException { context = null; }
    }

    private static Set<Instrument> getForexInstruments() {
        Set<Instrument> out = new HashSet<>();
        for (Instrument i : Instrument.values()) {
            String n = i.name();
            if (n.matches("^(EUR|GBP|USD|JPY|CHF|AUD|CAD|NZD|XAU|XAG)/.*$")) {
                out.add(i);
                symbolDigits.put(i.name(), i.getPipScale() + 1);
            }
        }
        return out;
    }

    // ─── Connect ────────────────────────────────────────────────────────────────

    private static void handleConnect(HttpExchange ex) throws IOException {
        if (!"POST".equals(ex.getRequestMethod())) { sendJson(ex, 405, err("use POST")); return; }
        try {
            Map<String, Object> req = parseJson(readBody(ex));
            String u = str(req.get("username"));
            String p = str(req.get("password"));
            String j = str(req.get("jnlpUrl"));
            if (u == null || p == null) { sendJson(ex, 400, err("username e password são obrigatórios")); return; }
            if (j != null && !j.isEmpty()) jnlpUrl = j;
            username = u; password = p;
            connect();
            sendJson(ex, 200, ok("connected", connected.get()));
        } catch (Exception e) {
            sendJson(ex, 500, err(e.getMessage()));
        }
    }

    private static synchronized void connect() throws Exception {
        if (client != null && client.isConnected()) return;
        client = ClientFactory.getDefaultInstance();
        client.setSystemListener(new ISystemListener() {
            @Override public void onStart(long processId) {}
            @Override public void onStop(long processId) {
                if (client.getStartedStrategies().size() == 0) System.out.println("[DukascopyBridge] Strategy parada");
            }
            @Override public void onConnect() {
                connected.set(true);
                System.out.println("[DukascopyBridge] Conectado à Dukascopy");
            }
            @Override public void onDisconnect() {
                connected.set(false);
                System.out.println("[DukascopyBridge] Desconectado. Reconectando...");
                new Thread(() -> {
                    try {
                        Thread.sleep(5000);
                        if (client != null && !client.isConnected()) client.connect(jnlpUrl, username, password);
                    } catch (Exception e) { System.err.println("Reconnect falhou: " + e.getMessage()); }
                }).start();
            }
        });
        System.out.println("[DukascopyBridge] Conectando em " + jnlpUrl + " ...");
        client.connect(jnlpUrl, username, password);
        int waited = 0;
        while (!client.isConnected() && waited < 30) { Thread.sleep(1000); waited++; }
        if (!client.isConnected()) throw new RuntimeException("Falha ao conectar na Dukascopy (login/senha/JNLP inválidos?)");
        // Inicia a strategy que mantém a sessão e coleta preços
        client.startStrategy(new BridgeStrategy());
        Thread.sleep(2000); // aguarda onStart/subscribe
        System.out.println("[DukascopyBridge] Conectado com sucesso.");
    }

    // ─── Markets ────────────────────────────────────────────────────────────────

    private static void handleMarkets(HttpExchange ex) throws IOException {
        if (!connected.get()) { sendJson(ex, 503, err("não conectado")); return; }
        List<Map<String, Object>> out = new ArrayList<>();
        for (Instrument i : Instrument.values()) {
            String n = i.name();
            if (n.matches("^(EUR|GBP|USD|JPY|CHF|AUD|CAD|NZD|XAU|XAG)/.*$")) {
                Map<String, Object> m = new HashMap<>();
                m.put("symbol", n);
                m.put("base", n.split("/")[0]);
                m.put("quote", n.split("/")[1]);
                m.put("digits", i.getPipScale() + 1);
                m.put("pipValue", i.getPipValue());
                m.put("contractSize", 100000.0); // lote padrão FX
                m.put("enabled", true);
                out.add(m);
            }
        }
        sendJson(ex, 200, ok("markets", out));
    }

    // ─── Tickers ────────────────────────────────────────────────────────────────

    private static void handleTickers(HttpExchange ex) throws IOException {
        if (!connected.get()) { sendJson(ex, 503, err("não conectado")); return; }
        String q = ex.getRequestURI().getQuery();
        String symbolsParam = q == null ? "" : parseQuery(q).getOrDefault("symbols", "");
        List<Map<String, Object>> out = new ArrayList<>();
        for (String sym : symbolsParam.split(",")) {
            sym = sym.trim().toUpperCase();
            if (sym.isEmpty()) continue;
            Map<String, Object> m = tickerJson(sym);
            if (m != null) out.add(m);
        }
        sendJson(ex, 200, ok("tickers", out));
    }

    private static void handleTicker(HttpExchange ex) throws IOException {
        if (!connected.get()) { sendJson(ex, 503, err("não conectado")); return; }
        String q = ex.getRequestURI().getQuery();
        String sym = q == null ? "" : parseQuery(q).getOrDefault("symbol", "");
        sym = sym.trim().toUpperCase();
        Map<String, Object> m = tickerJson(sym);
        if (m == null) { sendJson(ex, 404, err("símbolo sem preço: " + sym)); return; }
        sendJson(ex, 200, ok("ticker", m));
    }

    private static Map<String, Object> tickerJson(String symbol) {
        double[] t = lastTicks.get(symbol);
        if (t == null) return null;
        Map<String, Object> m = new HashMap<>();
        m.put("symbol", symbol);
        m.put("bid", t[0]);
        m.put("ask", t[1]);
        m.put("last", (t[0] + t[1]) / 2);
        m.put("timestamp", System.currentTimeMillis());
        return m;
    }

    // ─── Order ──────────────────────────────────────────────────────────────────

    private static void handleOrder(HttpExchange ex) throws IOException {
        if (!"POST".equals(ex.getRequestMethod())) { sendJson(ex, 405, err("use POST")); return; }
        if (!connected.get() || context == null) { sendJson(ex, 503, err("não conectado")); return; }
        try {
            Map<String, Object> req = parseJson(readBody(ex));
            String symbol = str(req.get("symbol")).toUpperCase();
            String side = str(req.get("side")).toLowerCase();
            double amount = Double.parseDouble(str(req.get("amount")));
            CompletableFuture<IOrder> future = new CompletableFuture<>();
            orderQueue.put(new OrderRequest(symbol, side, amount, future));
            IOrder order = future.get(15, TimeUnit.SECONDS);
            Map<String, Object> m = new HashMap<>();
            m.put("id", order.getId());
            m.put("label", order.getLabel());
            m.put("symbol", order.getInstrument().name());
            m.put("side", order.isLong() ? "buy" : "sell");
            m.put("amount", order.getAmount());
            m.put("price", order.getOpenPrice());
            m.put("state", String.valueOf(order.getState()));
            sendJson(ex, 200, ok("order", m));
        } catch (Exception e) {
            sendJson(ex, 500, err(e.getMessage()));
        }
    }

    // ─── Positions ──────────────────────────────────────────────────────────────

    private static void handlePositions(HttpExchange ex) throws IOException {
        if (!connected.get() || context == null) { sendJson(ex, 503, err("não conectado")); return; }
        try {
            IEngine engine = context.getEngine();
            List<Map<String, Object>> out = new ArrayList<>();
            for (IOrder o : engine.getOrders()) {
                if (o.getState() == IOrder.State.FILLED || o.getState() == IOrder.State.OPENED) {
                    Map<String, Object> m = new HashMap<>();
                    m.put("id", o.getId());
                    m.put("symbol", o.getInstrument().name());
                    m.put("side", o.isLong() ? "buy" : "sell");
                    m.put("amount", o.getAmount());
                    m.put("openPrice", o.getOpenPrice());
                    m.put("profitLoss", o.getProfitLossInAccountCurrency());
                    out.add(m);
                }
            }
            sendJson(ex, 200, ok("positions", out));
        } catch (Exception e) {
            sendJson(ex, 500, err(e.getMessage()));
        }
    }

    // ─── Account ────────────────────────────────────────────────────────────────

    private static void handleAccount(HttpExchange ex) throws IOException {
        if (!connected.get() || context == null) { sendJson(ex, 503, err("não conectado")); return; }
        try {
            IAccount acc = context.getAccount();
            Map<String, Object> m = new HashMap<>();
            m.put("balance", acc.getBalance());
            m.put("equity", acc.getEquity());
            m.put("currency", acc.getCurrency().getCurrencyCode());
            m.put("leverage", acc.getLeverage());
            sendJson(ex, 200, ok("account", m));
        } catch (Exception e) {
            sendJson(ex, 500, err(e.getMessage()));
        }
    }

    // ─── Health ─────────────────────────────────────────────────────────────────

    private static void handleHealth(HttpExchange ex) throws IOException {
        Map<String, Object> m = new HashMap<>();
        m.put("connected", connected.get());
        m.put("contextReady", context != null);
        m.put("tickers", lastTicks.size());
        sendJson(ex, 200, ok("health", m));
    }

    // ─── Helpers ────────────────────────────────────────────────────────────────

    private static class OrderRequest {
        final String symbol; final String side; final double amount; final CompletableFuture<IOrder> result;
        OrderRequest(String s, String side, double a, CompletableFuture<IOrder> r) { this.symbol = s; this.side = side; this.amount = a; this.result = r; }
    }

    private static Map<String, Object> ok(String key, Object value) {
        Map<String, Object> m = new HashMap<>();
        m.put("success", true);
        m.put(key, value);
        return m;
    }

    private static Map<String, Object> err(String msg) {
        Map<String, Object> m = new HashMap<>();
        m.put("success", false);
        m.put("error", msg);
        return m;
    }

    private static void sendJson(HttpExchange ex, int status, Object obj) throws IOException {
        String json = toJson(obj);
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(bytes); }
    }

    private static String toJson(Object obj) {
        if (obj == null) return "null";
        if (obj instanceof String) return "\"" + escapeJson((String) obj) + "\"";
        if (obj instanceof Number || obj instanceof Boolean) return obj.toString();
        if (obj instanceof Map) {
            StringBuilder sb = new StringBuilder("{");
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) obj).entrySet()) {
                if (!first) sb.append(",");
                sb.append("\"").append(escapeJson(String.valueOf(e.getKey()))).append("\":").append(toJson(e.getValue()));
                first = false;
            }
            return sb.append("}").toString();
        }
        if (obj instanceof List) {
            StringBuilder sb = new StringBuilder("[");
            boolean first = true;
            for (Object o : (List<?>) obj) {
                if (!first) sb.append(",");
                sb.append(toJson(o));
                first = false;
            }
            return sb.append("]").toString();
        }
        return "\"" + escapeJson(obj.toString()) + "\"";
    }

    private static String escapeJson(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r");
    }

    private static String readBody(HttpExchange ex) throws IOException {
        try (BufferedReader br = new BufferedReader(new InputStreamReader(ex.getRequestBody(), StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) sb.append(line);
            return sb.toString();
        }
    }

    private static Map<String, Object> parseJson(String json) {
        Map<String, Object> map = new HashMap<>();
        if (json == null || json.trim().isEmpty()) return map;
        String s = json.trim();
        if (s.startsWith("{")) s = s.substring(1, s.length() - 1);
        for (String part : s.split(",")) {
            int eq = part.indexOf(':');
            if (eq == -1) continue;
            String k = part.substring(0, eq).trim().replace("\"", "");
            String v = part.substring(eq + 1).trim();
            if (v.startsWith("\"")) v = v.substring(1, v.length() - 1);
            map.put(k, v);
        }
        return map;
    }

    private static Map<String, String> parseQuery(String query) {
        Map<String, String> m = new HashMap<>();
        if (query == null || query.isEmpty()) return m;
        for (String p : query.split("&")) {
            int eq = p.indexOf('=');
            if (eq == -1) m.put(p, "");
            else m.put(p.substring(0, eq), p.substring(eq + 1));
        }
        return m;
    }

    private static String str(Object o) { return o == null ? null : String.valueOf(o); }
}
