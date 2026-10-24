import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  diagnose,
  diagnoseRendererHelperCollisions,
  patch,
  rendererChanges,
  rendererHelperNames,
} from '../tools/patches.mjs';

class FakeEventTarget {
  listeners = new Map();

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(type) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type });
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

function loadBillingHook(source, { exposeHelpers = true } = {}) {
  const sentinel = Symbol.for('react.memo_cache_sentinel');
  const memoCache = Array(3).fill(sentinel);
  const window = new FakeEventTarget();
  const document = new FakeEventTarget();
  let focused = true;
  let airgapEnabled = false;
  document.visibilityState = 'visible';
  document.hasFocus = () => focused;

  const store = { unsubscribe: null, subscribe: null, notifications: 0 };
  const P = {
    useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot) {
      if (subscribe !== store.subscribe) {
        store.unsubscribe?.();
        store.subscribe = subscribe;
        store.unsubscribe = subscribe(() => { store.notifications++; });
      }
      store.getSnapshot = getSnapshot;
      store.getServerSnapshot = getServerSnapshot;
      return getSnapshot();
    },
  };

  const hooks = vm.runInNewContext(
    `${source}\n({billingLimits:Sit${exposeHelpers ? ', snapshot:factoryLinuxBillingFocusSnapshot' : ''}})`,
    {
      Symbol,
      P,
      window,
      document,
      z: { c: size => {
        assert.equal(size, memoCache.length);
        return memoCache;
      } },
      Fu: () => airgapEnabled,
      Xn: { billing: { tokenLimits: ['billing', 'tokenLimits'] } },
      io: (query, options) => ({ query, options }),
    },
  );

  return {
    ...hooks,
    window,
    document,
    store,
    setFocused(value) { focused = value; },
    setAirgapEnabled(value) { airgapEnabled = value; },
  };
}

test('billing query follows renderer focus without changing global query focus', () => {
  const [name, before, after] = rendererChanges[0];
  const patchedSource = patch(before, rendererChanges);
  assert.ok(patchedSource.includes(after), name);
  assert.equal(patchedSource, after, 'the pinned hook and local helpers are the only renderer change');
  assert.deepEqual(diagnose(before, rendererChanges), []);
  assert.deepEqual(diagnoseRendererHelperCollisions(before), []);

  const app = loadBillingHook(patchedSource);
  const render = enabled => app.billingLimits(enabled);
  const active = render();
  assert.equal(active.query.endpoint, '/api/billing/limits');
  assert.equal(active.query.method, 'GET');
  assert.deepEqual(active.query.queryKey, ['billing', 'tokenLimits']);
  assert.equal(active.query.enabled, true);
  assert.equal(active.options.refetchInterval, 20_000);
  assert.equal(active.options.refetchIntervalInBackground, false);
  assert.equal(active.options.refetchOnWindowFocus, true);
  assert.equal(active.options.retry, false);
  assert.equal(app.window.listenerCount('focus'), 1);
  assert.equal(app.window.listenerCount('blur'), 1);
  assert.equal(app.document.listenerCount('visibilitychange'), 1);
  assert.equal(typeof app.store.getServerSnapshot, 'function');

  // The same React memo cache survives renders, as useMemoCache does in React.
  // Focus changes the existing `o` dependency and replaces only the query args.
  app.setFocused(false);
  app.window.dispatchEvent('blur');
  const blurred = render();
  assert.equal(app.store.notifications, 1);
  assert.equal(app.snapshot(), false);
  assert.equal(blurred.query.enabled, false);
  assert.equal(blurred.options, active.options, 'interval options remain memoized');

  app.document.visibilityState = 'hidden';
  app.document.dispatchEvent('visibilitychange');
  assert.equal(app.snapshot(), false);
  app.document.visibilityState = 'visible';
  app.document.dispatchEvent('visibilitychange');
  assert.equal(app.snapshot(), false, 'visible but unfocused stays disabled');

  app.setFocused(true);
  app.window.dispatchEvent('focus');
  const focused = render();
  assert.equal(app.snapshot(), true);
  assert.equal(focused.query.enabled, true, 'focus re-enables the stale query immediately');
  assert.equal(focused.options, active.options);

  const callerDisabled = render(false);
  assert.equal(callerDisabled.query.enabled, false, 'caller enablement is preserved');
  app.setAirgapEnabled(true);
  assert.equal(render().query.enabled, false, 'the airgap gate is preserved');
  app.setAirgapEnabled(false);

  app.store.unsubscribe();
  assert.equal(app.window.listenerCount('focus'), 0);
  assert.equal(app.window.listenerCount('blur'), 0);
  assert.equal(app.document.listenerCount('visibilitychange'), 0);
});

test('the unpatched upstream hook keeps polling while hidden', () => {
  // Control proving the focus assertions above detect an unpatched bundle:
  // run the real 0.205.0 anchor (no helpers, background refetch enabled) and
  // verify it does not react to blur or visibility at all.
  const [, before] = rendererChanges[0];
  const app = loadBillingHook(before, { exposeHelpers: false });
  assert.equal(app.billingLimits().query.enabled, true);
  app.window.dispatchEvent('blur');
  app.document.visibilityState = 'hidden';
  app.document.dispatchEvent('visibilitychange');
  const hidden = app.billingLimits();
  assert.equal(hidden.query.enabled, true, 'unpatched source polls while hidden');
  assert.equal(hidden.options.refetchIntervalInBackground, true);
});

test('renderer patch fails closed for missing, duplicated, or colliding anchors', () => {
  const [, before] = rendererChanges[0];
  const unrelated = 'unrelated renderer source';
  assert.equal(diagnose(unrelated, rendererChanges)[0].count, 0);
  assert.throws(() => patch(unrelated, rendererChanges));
  assert.equal(diagnose(`${before}\n${before}`, rendererChanges)[0].count, 2);
  assert.throws(() => patch(`${before}\n${before}`, rendererChanges));

  const collision = `${before}\nfunction ${rendererHelperNames[0]}(){}`;
  assert.deepEqual(diagnoseRendererHelperCollisions(collision), [rendererHelperNames[0]]);
});
