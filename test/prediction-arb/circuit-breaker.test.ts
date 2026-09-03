import assert from 'node:assert/strict';
import test from 'node:test';
import { CircuitBreaker, CircuitOpenError } from '../../src/utils/circuit-breaker';

test('abre após falhas consecutivas e bloqueia chamadas', async () => {
  const breaker = new CircuitBreaker('test', { failureThreshold: 2, resetTimeoutMs: 60_000 });
  await assert.rejects(() => breaker.execute(async () => { throw new Error('one'); }));
  await assert.rejects(() => breaker.execute(async () => { throw new Error('two'); }));
  await assert.rejects(() => breaker.execute(async () => 'blocked'), CircuitOpenError);
});
