import assert from 'node:assert/strict';
import test from 'node:test';
import { completenessSpreadPct, makerEntryPrices, netPairReturn } from '../../src/strategy/prediction-arb/helpers/pricing';

test('calcula spread de completude corretamente', () => {
  const spread = completenessSpreadPct({ yes: 0.47, no: 0.52 });
  assert.ok(Math.abs(spread - 1) < 1e-9);
});

test('makerEntryPrices nunca ultrapassa soma de um', () => {
  const entry = makerEntryPrices(0.5, 0.49, 0.3);
  assert.ok(entry);
  assert.ok(entry.yes + entry.no < 1);
  assert.ok(entry.yes >= 0);
  assert.ok(entry.no >= 0);
});

test('makerEntryPrices with spread maker suficiente usa maker', () => {
  const entry = makerEntryPrices(0.5, 0.5, 0.01);
  assert.ok(entry);
  assert.ok(entry.yes + entry.no <= 1);
});

test('retorno líquido considera custo do par', () => {
  const retorno = netPairReturn({ yes: 0.4, no: 0.4 }, 5, 0);
  assert.ok(retorno > 0);
});

test('netPairReturn with zero cost returns investment', () => {
  const retorno = netPairReturn({ yes: 0.5, no: 0.5 }, 0, 0);
  assert.ok(retorno >= 0);
});