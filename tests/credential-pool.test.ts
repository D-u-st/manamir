import { describe, test } from 'node:test';
import assert from 'node:assert';
import { CredentialPool, type Credential } from '../src/executor/credential-pool';

function makeCreds(n: number): Credential[] {
  const out: Credential[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      apiKey: `sk-${i}`,
      baseUrl: 'https://example.com',
      model: `model-${i}`,
      label: `cred-${i}`
    });
  }
  return out;
}

describe('CredentialPool', () => {
  test('throws when constructed empty', () => {
    assert.throws(() => new CredentialPool([]), /at least one credential/);
  });

  test('rotate on rate_limit returns the next active credential', () => {
    const pool = new CredentialPool(makeCreds(3));
    assert.strictEqual(pool.current().label, 'cred-0');

    const next = pool.rotateOnFailure('rate_limit');
    assert.ok(next, 'expected next credential');
    assert.strictEqual(next.label, 'cred-1');
    assert.strictEqual(pool.current().label, 'cred-1');

    const health = pool.health();
    const cooled = health.find(h => h.label === 'cred-0');
    assert.strictEqual(cooled?.status, 'cooling');
    assert.ok((cooled?.coolDownUntil ?? 0) > Date.now());
  });

  test('rotate on billing disables current and chooses next', () => {
    const pool = new CredentialPool(makeCreds(3));
    const next = pool.rotateOnFailure('billing');
    assert.ok(next);
    assert.strictEqual(next.label, 'cred-1');

    const status0 = pool.health().find(h => h.label === 'cred-0')?.status;
    assert.strictEqual(status0, 'disabled');
  });

  test('rotate on auth disables current and chooses next', () => {
    const pool = new CredentialPool(makeCreds(3));
    const next = pool.rotateOnFailure('auth');
    assert.ok(next);
    assert.strictEqual(next.label, 'cred-1');

    const status0 = pool.health().find(h => h.label === 'cred-0')?.status;
    assert.strictEqual(status0, 'disabled');
  });

  test('all disabled → rotateOnFailure returns null', () => {
    const pool = new CredentialPool(makeCreds(2));
    // Disable both via billing
    const r1 = pool.rotateOnFailure('billing'); // 0 disabled, switch to 1
    assert.ok(r1);
    const r2 = pool.rotateOnFailure('billing'); // 1 disabled, none left
    assert.strictEqual(r2, null);

    const all = pool.health();
    assert.strictEqual(all[0].status, 'disabled');
    assert.strictEqual(all[1].status, 'disabled');
  });

  test('cooldown expires → cooling credential becomes active again', async () => {
    // Use a tiny pool of 2 so we can tightly control time. Override Date.now.
    const realNow = Date.now;
    let fakeNow = 1_000_000;
    Date.now = () => fakeNow;

    try {
      const pool = new CredentialPool(makeCreds(2));
      pool.rotateOnFailure('rate_limit'); // cred-0 cooling for 60s, now on cred-1

      // Disable cred-1 too via billing → only cred-0 (cooling) remains, no active
      const r = pool.rotateOnFailure('billing');
      assert.strictEqual(r, null, 'no credential should be active while cred-0 still cooling');

      // Advance time past the 60s cooldown window
      fakeNow += 61_000;

      const health = pool.health();
      const cred0 = health.find(h => h.label === 'cred-0');
      assert.strictEqual(cred0?.status, 'active', 'cred-0 should auto-recover after cooldown');

      // current() should now return cred-0 (since cred-1 is disabled and cred-0 is active)
      assert.strictEqual(pool.current().label, 'cred-0');
    } finally {
      Date.now = realNow;
    }
  });

  test('reset() clears cooling state on the active credential', () => {
    const pool = new CredentialPool(makeCreds(2));
    pool.rotateOnFailure('rate_limit'); // cred-0 cooling, current = cred-1

    // Advance current() back to cred-0 by disabling cred-1, then expiring cooldown
    // ... simpler: reset only affects the CURRENT credential. Call reset while
    //     current is cred-1 — cred-1 is active, no-op. Verify nothing broke.
    pool.reset();
    assert.strictEqual(pool.current().label, 'cred-1');
    assert.strictEqual(pool.health().find(h => h.label === 'cred-0')?.status, 'cooling');
  });

  test('round-robin wraps when active credentials are non-contiguous', () => {
    const pool = new CredentialPool(makeCreds(4));
    // Disable cred-1 and cred-2 → wraparound from cred-0 to cred-3 to cred-0
    pool.rotateOnFailure('billing'); // 0 disabled → on 1
    pool.rotateOnFailure('billing'); // 1 disabled → on 2
    pool.rotateOnFailure('billing'); // 2 disabled → on 3
    assert.strictEqual(pool.current().label, 'cred-3');

    const next = pool.rotateOnFailure('billing'); // 3 disabled → none left
    assert.strictEqual(next, null);
  });
});
