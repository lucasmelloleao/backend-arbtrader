const WebSocket = require('ws');

const ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

ws.on('open', () => {
  ws.send(JSON.stringify({ active_symbols: 'brief', product_type: 'basic' }));
});

ws.on('message', (data) => {
  const json = JSON.parse(data.toString());
  if (json.active_symbols) {
    const cryptos = json.active_symbols.filter(s => s.market === 'cryptocurrency' || s.symbol.toLowerCase().includes('btc') || s.symbol.toLowerCase().includes('eth'));
    console.log("CRIPTO SIMBOLOS NA DERIV:");
    console.log(cryptos.map(s => ({ symbol: s.symbol, display_name: s.display_name, market: s.market })));
    ws.close();
    process.exit(0);
  }
});
