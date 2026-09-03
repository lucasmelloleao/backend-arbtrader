import assert from 'node:assert/strict';
import test from 'node:test';
import { completenessSpreadPct, makerEntryPrices, netPairReturn } from '../../src/strategy/prediction-arb/helpers/pricing';

test('calcula spread de completude', () => {
  assert.ok(Math.abs(completenessSpreadPct({ yes: 0.47, no: 0.52 }) - 1) < 1e-9);
});

test('makerEntryPrices nunca ultrapassa soma de um', () => {
  const entry = makerEntryPrices(0.5, 0.49, 0.3);
  assert.ok(entry);
  assert.ok(entry.yes + entry.no < 1);
});

test('retorno líquido considera custo do par', () => {
  assert.ok(netPairReturn({ yes: 0.4, no: 0.4 }, 5, 0) > 0);
});
