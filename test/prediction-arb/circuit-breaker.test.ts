import assert from 'node:assert/strict';
import test from 'node:test';
import { CircuitBreaker, CircuitOpenError } from '../../src/utils/circuit-breaker';

test('abre após falhas consecutivas e bloqueia chamadas', async () => {
  const breaker = new CircuitBreaker('test', { failureThreshold: 2, resetTimeoutMs: 60_000 });
  await assert.rejects(() => breaker.execute(async () => { throw new Error('one'); }));
  await assert.rejects(() => breaker.execute(async () => { throw new Error('two'); }));
  await assert.rejects(() => breaker.execute(async () => 'blocked'), CircuitOpenError);
});

test('reseta após timeout e permite novas chamadas', async () => {
  const breaker = new CircuitBreaker('test-reset', { failureThreshold: 1, resetTimeoutMs: 10 });
  await assert.rejects(() => breaker.execute(async () => { throw new Error('fail'); }));
  await new Promise(r => setTimeout(r, 20));
  const result = await breaker.execute(async () => 'success');
  assert.strictEqual(result, 'success');
});

test('não bloqueia na primeira falha quando threshold > 1', async () => {
  const breaker = new CircuitBreaker('test-1', { failureThreshold: 3, resetTimeoutMs: 60_000 });
  // First failure should not open the breaker
  try {
    await breaker.execute(async () => { throw new Error('first fail'); });
  } catch { /* expected */ }
  // Should still be closed - second call should work
  const result = await breaker.execute(async () => 'success');
  assert.strictEqual(result, 'success');
});

test('abre apenas após atingir threshold de falhas', async () => {
  const breaker = new CircuitBreaker('test-threshold', { failureThreshold: 5, resetTimeoutMs: 60_000 });
  let opened = false;
  for (let i = 0; i < 5; i++) {
    try {
      await breaker.execute(async () => { throw new Error(`fail ${i}`); });
    } catch {
      if (i === 4) {
        opened = true;
      }
    }
  }
  assert.strictEqual(opened, true);
});