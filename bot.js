// ================================================================
//  CRASH 500 INSIDE BAR BOT -- Node.js 24/7 Server Version
//  Strategy : Inside Bar Compression + ATR Breakout
//  Entry    : BUY when close > inside bar high
//             SELL when close < inside bar low
//  SL       : Fixed dollar = stake amount
//  TP       : Fixed dollar = stake x 2 (1:2 RR)
//  Filter   : ATR(14) must be valid, 1 candle cooldown
//  Symbol   : CRASH500 | Timeframe: M1
//  Deploy   : Render / Koyeb / any Node.js host
// ================================================================

const WebSocket = require('ws');
const http      = require('http');

// ── CONFIG ── set via environment variables on Render ───────────
const API_TOKEN  = process.env.DERIV_TOKEN || 'YOUR_TOKEN_HERE';
const STAKE      = parseFloat(process.env.STAKE || '1');
const MULTIPLIER = parseInt(process.env.MULTIPLIER || '100');
const SYMBOL     = 'CRASH500';
const CANDLE_COUNT = 100;

// Fixed dollar risk (1:2 RR)
const SL_AMOUNT = parseFloat(STAKE.toFixed(2));
const TP_AMOUNT = parseFloat((STAKE * 2).toFixed(2));

// ── Logging ──────────────────────────────────────────────────────
function log(tag, msg) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${t}] [${tag}] ${msg}`);
}

// ── ATR Indicator ─────────────────────────────────────────────────
function calcATR(candles, p) {
  const out = [];
  let trSum = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { out.push(null); continue; }
    const tr = Math.max(
      candles[i].high  - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low  - candles[i - 1].close)
    );
    if (i <= p) {
      trSum += tr;
      if (i === p) out.push(trSum / p);
      else out.push(null);
      continue;
    }
    const prev = out[out.length - 1];
    out.push((prev * (p - 1) + tr) / p);
  }
  return out;
}

// ── Signal detection ─────────────────────────────────────────────
function detectSignal(candles) {
  if (candles.length < 5) return null;

  const n    = candles.length - 1;
  const curr = candles[n];
  const prev = candles[n - 1]; // potential inside bar
  const base = candles[n - 2]; // mother bar

  const atr = calcATR(candles, 14);
  if (!atr[n]) return null;

  // Step 1 — Check if previous candle was an Inside Bar
  const isInsideBar = prev.high < base.high && prev.low > base.low;
  if (!isInsideBar) {
    log('SCAN', `No inside bar | prev H:${prev.high} base H:${base.high} | prev L:${prev.low} base L:${base.low}`);
    return null;
  }

  // Step 2 — Check if current candle breaks out of inside bar range
  let dir = null;
  if (curr.close > prev.high) dir = 'BUY';
  else if (curr.close < prev.low) dir = 'SELL';

  if (!dir) {
    log('WAIT', `Inside bar detected but no breakout yet | IB H:${prev.high} L:${prev.low} | Close:${curr.close}`);
    return null;
  }

  // ATR-based price levels (for logging reference only — dollar risk is fixed)
  const slDist = atr[n] * 1.5;
  const tpDist = atr[n] * 3.0;
  const slPrice = dir === 'BUY' ? curr.close - slDist : curr.close + slDist;
  const tpPrice = dir === 'BUY' ? curr.close + tpDist : curr.close - tpDist;

  return {
    dir,
    entry:   curr.close,
    slPrice: slPrice.toFixed(4),
    tpPrice: tpPrice.toFixed(4),
    atr:     atr[n].toFixed(4),
    ibHigh:  prev.high,
    ibLow:   prev.low
  };
}

// ── Trade execution ──────────────────────────────────────────────
function placeTrade(signal) {
  if (!authorized)  { log('SKIP', 'Not authorized'); return; }
  if (tradeOpen)    { log('SKIP', 'Trade already open'); return; }

  const contractType = signal.dir === 'BUY' ? 'MULTUP' : 'MULTDOWN';

  log('TRADE', `Placing ${signal.dir} | Entry: ${signal.entry} | SL $${SL_AMOUNT} | TP $${TP_AMOUNT} | ATR: ${signal.atr}`);
  log('TRADE', `IB range: ${signal.ibLow} - ${signal.ibHigh} | SL price: ${signal.slPrice} | TP price: ${signal.tpPrice}`);

  ws.send(JSON.stringify({
    buy: 1,
    price: STAKE,
    parameters: {
      contract_type: contractType,
      symbol:        SYMBOL,
      basis:         'stake',
      amount:        STAKE,
      currency:      'USD',
      multiplier:    MULTIPLIER,
      limit_order: {
        stop_loss:   SL_AMOUNT,
        take_profit: TP_AMOUNT
      }
    }
  }));
}

// ── Check and trade on each new candle ────────────────────────────
function checkAndTrade() {
  const now = candles[candles.length - 1]?.time || 0;

  // Cooldown: 1 candle after each trade
  if (now <= cooldownUntil) {
    log('COOL', `Cooldown active -- waiting for next candle`);
    return;
  }

  // Safety: reset stuck tradeOpen after 10 mins
  if (tradeOpen && tradeOpenSince > 0 && (now - tradeOpenSince) > 600) {
    log('SYS', 'Trade open flag stuck -- auto-resetting');
    tradeOpen = false;
    tradeOpenSince = 0;
  }

  if (tradeOpen) { log('SKIP', 'Trade already open'); return; }

  const signal = detectSignal(candles);
  if (!signal) return;

  // Prevent same direction re-entry without reversal
  if (signal.dir === lastSignal) {
    log('SKIP', `Same direction ${signal.dir} -- waiting for opposite setup`);
    return;
  }

  log('SIGNAL', `INSIDE BAR BREAKOUT | ${signal.dir} | Entry: ${signal.entry} | ATR: ${signal.atr}`);
  lastSignal    = signal.dir;
  cooldownUntil = now + 60; // 1 candle cooldown (60 seconds)
  placeTrade(signal);
}

// ── State ────────────────────────────────────────────────────────
let ws             = null;
let candles        = [];
let lastSignal     = null;
let authorized     = false;
let tradeOpen      = false;
let tradeOpenSince = 0;
let cooldownUntil  = 0;
let reconnectTimer = null;
let stats = { trades: 0, wins: 0, losses: 0, pnl: 0 };

// ── WebSocket ────────────────────────────────────────────────────
const APP_IDS = [36544, 1089, 62019];
let appIdx = 0;

function connect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const url = `wss://ws.binaryws.com/websockets/v3?app_id=${APP_IDS[appIdx]}`;
  log('SYS', `Connecting (app_id: ${APP_IDS[appIdx]})...`);

  ws = new WebSocket(url);

  ws.on('open', () => {
    log('SYS', 'Connected -- authorizing...');
    ws.send(JSON.stringify({ authorize: API_TOKEN }));
  });

  ws.on('message', raw => {
    let d;
    try { d = JSON.parse(raw); } catch(e) { return; }
    handleMsg(d);
  });

  ws.on('error', err => log('ERR', `WebSocket error: ${err.message}`));

  ws.on('close', () => {
    authorized     = false;
    tradeOpen      = false;
    tradeOpenSince = 0;
    log('SYS', 'Disconnected -- reconnecting in 5s...');
    appIdx = (appIdx + 1) % APP_IDS.length;
    reconnectTimer = setTimeout(connect, 5000);
  });
}

function handleMsg(d) {
  if (d.error) { log('ERR', `${d.error.code}: ${d.error.message}`); return; }

  switch (d.msg_type) {

    case 'authorize': {
      authorized = true;
      const a = d.authorize;
      log('AUTH', `${a.loginid} | ${a.is_virtual ? 'DEMO' : 'REAL'} | ${a.currency} | Balance: ${a.balance}`);
      log('CFG',  `Symbol: ${SYMBOL} | Stake: $${STAKE} | SL: $${SL_AMOUNT} | TP: $${TP_AMOUNT} | x${MULTIPLIER} | RR: 1:2`);
      ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
      ws.send(JSON.stringify({
        ticks_history: SYMBOL,
        granularity:   60,
        style:         'candles',
        subscribe:     1,
        count:         CANDLE_COUNT,
        end:           'latest'
      }));
      break;
    }

    case 'candles': {
      candles = d.candles.map(c => ({
        time: +c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close
      }));
      log('DATA', `${candles.length} M1 candles loaded -- scanning for Inside Bar setups...`);
      checkAndTrade();
      break;
    }

    case 'ohlc': {
      const o  = d.ohlc;
      const nc = {
        time:  +(o.open_time || o.epoch),
        open:  +o.open,
        high:  +o.high,
        low:   +o.low,
        close: +o.close
      };
      const last = candles[candles.length - 1];
      if (last && last.time === nc.time) {
        candles[candles.length - 1] = nc; // update current candle
      } else {
        candles.push(nc);               // new candle formed
        if (candles.length > 200) candles.shift();
        log('TICK', `New M1 candle | Close: ${nc.close} | ${new Date(nc.time * 1000).toTimeString().slice(0, 8)}`);
        checkAndTrade();
      }
      break;
    }

    case 'balance': {
      if (d.balance) log('BAL', `Balance: ${d.balance.balance} ${d.balance.currency}`);
      break;
    }

    case 'buy': {
      if (d.buy) {
        tradeOpen      = true;
        tradeOpenSince = Math.floor(Date.now() / 1000);
        stats.trades++;
        log('OPEN', `Trade opened | ID: ${d.buy.contract_id} | SL $${SL_AMOUNT} | TP $${TP_AMOUNT}`);
        ws.send(JSON.stringify({
          proposal_open_contract: 1,
          contract_id: d.buy.contract_id,
          subscribe:   1
        }));
      }
      break;
    }

    case 'proposal_open_contract': {
      const poc = d.proposal_open_contract;
      if (!poc) break;

      if (poc.status === 'sold' || poc.status === 'won' || poc.status === 'lost') {
        tradeOpen      = false;
        tradeOpenSince = 0;

        const profit = parseFloat(poc.profit || 0);
        stats.pnl    = parseFloat((stats.pnl + profit).toFixed(2));

        if (profit > 0)      { stats.wins++;   log('WIN',  `WIN  +$${profit.toFixed(2)} | Session P&L: $${stats.pnl}`); }
        else if (profit < 0) { stats.losses++; log('LOSS', `LOSS $${profit.toFixed(2)} | Session P&L: $${stats.pnl}`); }

        const wr = stats.wins + stats.losses > 0
          ? ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(1) : 0;
        log('STAT', `Trades: ${stats.trades} | W:${stats.wins} L:${stats.losses} | WR: ${wr}% | P&L: $${stats.pnl}`);
      }
      break;
    }
  }
}

// ── HTTP status server ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const wr = stats.wins + stats.losses > 0
    ? ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(1) : '0';

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status:     authorized ? 'running' : 'connecting',
    strategy:   'Inside Bar Breakout | ATR(14) | 1:2 RR',
    symbol:     SYMBOL,
    timeframe:  'M1',
    authorized,
    tradeOpen,
    stake:      STAKE,
    sl:         SL_AMOUNT,
    tp:         TP_AMOUNT,
    multiplier: MULTIPLIER,
    candles:    candles.length,
    lastSignal,
    stats:      { ...stats, winRate: wr + '%' },
    uptime:     process.uptime().toFixed(0) + 's',
    timestamp:  new Date().toISOString()
  }, null, 2));
}).listen(PORT, '0.0.0.0', () => {
  log('SRV', `Status server on 0.0.0.0:${PORT}`);
});

// ── Start ────────────────────────────────────────────────────────
log('SYS', '=============================================');
log('SYS', '  CRASH 500 INSIDE BAR BOT -- 24/7 Edition ');
log('SYS', '=============================================');
log('SYS', `Symbol: ${SYMBOL} | Timeframe: M1`);
log('SYS', `Stake: $${STAKE} | SL: $${SL_AMOUNT} | TP: $${TP_AMOUNT} | x${MULTIPLIER}`);
log('SYS', `Strategy: Inside Bar Compression + ATR(14) Breakout | 1:2 RR`);
log('SYS', 'Connecting...');
connect();
