import test from 'node:test';
import assert from 'node:assert/strict';

import { decidePositionClose } from '../src/strategy/forex/forex-scalper';

test('close strategy uses positionId for real cTrader positions', () => {
  const decision = decidePositionClose({
    positionId: '123456',
    volumeProtocol: 200,
    amount: 100,
    side: 'BUY',
    symbol: 'EUR/USD',
  });

  assert.equal(decision.usePositionClose, true);
  assert.equal(decision.volumeProtocol, 200);
  assert.equal(decision.mode, 'position-close');
});

test('close strategy falls back to market order only for synthetic ids', () => {
  const decision = decidePositionClose({
    positionId: 'pos_1700000000000',
    volumeProtocol: 200,
    amount: 100,
    side: 'SELL',
    symbol: 'EUR/USD',
  });

  assert.equal(decision.usePositionClose, false);
  assert.equal(decision.mode, 'market-order');
});
