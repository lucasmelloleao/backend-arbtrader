import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calcEma,
  calcRsi,
  evaluateSignal,
  streakStakeMultiplier,
} from '../src/strategy/deriv/helpers/deriv-signal';

// Série sintética: +step, +step, retrace, repetindo (2 passos de tendência por 1 correção).
function trendSeries(start: number, step: number, retrace: number, length = 60): number[] {
  const out: number[] = [start];
  for (let i = 1; i < length; i++) {
    const move = i % 3 === 0 ? retrace : step;
    out.push(out[i - 1] + move);
  }
  return out;
}

test('streakStakeMultiplier mantém stake integral sem perdas', () => {
  assert.deepEqual(streakStakeMultiplier(0), { multiplier: 1, blocked: false });
  assert.deepEqual(streakStakeMultiplier(1), { multiplier: 1, blocked: false });
});

test('streakStakeMultiplier reduz stake com perdas consecutivas', () => {
  assert.deepEqual(streakStakeMultiplier(2), { multiplier: 0.5, blocked: false });
  assert.deepEqual(streakStakeMultiplier(3), { multiplier: 0.25, blocked: false });
  assert.deepEqual(streakStakeMultiplier(4), { multiplier: 0.25, blocked: false });
});

test('streakStakeMultiplier pausa após 5 perdas consecutivas', () => {
  assert.deepEqual(streakStakeMultiplier(5), { multiplier: 0, blocked: true });
});

test('calcRsi retorna 100 para série estritamente crescente', () => {
  const up = Array.from({ length: 20 }, (_, i) => 100 + i * 0.1);
  assert.equal(calcRsi(up, 14), 100);
});

test('calcRsi retorna 0 para série estritamente decrescente', () => {
  const down = Array.from({ length: 20 }, (_, i) => 100 - i * 0.1);
  assert.equal(calcRsi(down, 14), 0);
});

test('calcEma aproxima a média dos dados em série estável', () => {
  const flat = Array.from({ length: 30 }, () => 5);
  assert.equal(calcEma(flat, 9), 5);
});

test('evaluateSignal rejeita mercado lateral sem confluência', () => {
  const flat = Array.from({ length: 60 }, () => 100);
  const signal = evaluateSignal(flat);
  assert.equal(signal.direction, null);
  assert.equal(signal.indicators.avgAbsReturn, 0);
});

test('evaluateSignal rejeita tendência de alta sobrecomprada (RSI > 78)', () => {
  const overbought = trendSeries(100, 0.1, 0.1, 60); // só passos positivos → RSI 100
  const signal = evaluateSignal(overbought);
  assert.equal(signal.direction, null);
});

test('evaluateSignal identifica CALL em tendência de alta moderada', () => {
  const uptrend = trendSeries(100, 0.1, -0.08, 60);
  const signal = evaluateSignal(uptrend);
  assert.equal(signal.direction, 'CALL');
  assert.ok(signal.confidence > 0);
});

test('evaluateSignal identifica PUT em tendência de baixa moderada', () => {
  const downtrend = trendSeries(100, -0.1, 0.08, 60);
  const signal = evaluateSignal(downtrend);
  assert.equal(signal.direction, 'PUT');
  assert.ok(signal.confidence > 0);
});
