import { describe, it, expect } from '@jest/globals';
import {
  currentView,
  listedOnView,
  runOnView,
  signInInstruction,
  type ServingView,
} from '../serving-view.js';
import { describeOperation } from '../executor/describe.js';

/** A view serving only `served`; everything else lives on one other address. */
function viewServing(...served: string[]): ServingView {
  return {
    serves: (name) => served.includes(name),
    addressesServing: (name) =>
      name === 'gone_tool' ? [] : ['https://example.test/pro'],
  };
}

describe('serving view', () => {
  it('counts every tool as served outside a call', () => {
    expect(currentView().serves('anything_at_all')).toBe(true);
    expect(signInInstruction('x_list')).toBe(
      'Authentication required. Call auth_login before using x_list.'
    );
  });

  it('binds the view for the call only', async () => {
    const view = viewServing('x_list');
    await runOnView(view, async () => {
      await Promise.resolve();
      expect(currentView()).toBe(view);
    });
    expect(currentView()).not.toBe(view);
  });

  it('sends a signed-out caller to the host where password login is withheld', () => {
    runOnView(viewServing('x_list'), () => {
      const text = signInInstruction('x_list');
      expect(text).not.toContain('auth_login');
      expect(text).toContain('reconnect Altegio there, then retry');
    });
  });

  it('lists a spec unchanged when the view serves everything it names', () => {
    const spec = {
      name: 'x_list',
      description: 'Find the id with y_get.',
      inputSchema: {},
    };
    expect(listedOnView(spec, viewServing('y_get'), ['x_list', 'y_get'])).toBe(
      spec
    );
  });

  it('appends where each withheld tool is served, grouped by address', () => {
    const spec = {
      name: 'x_list',
      description: 'Then change it with y_update or z_delete.',
      inputSchema: {
        properties: { id: { description: 'From gone_tool.' } },
      },
    };
    const listed = listedOnView(spec, viewServing(), [
      'x_list',
      'y_update',
      'z_delete',
      'gone_tool',
      'y_update_more',
    ]);
    expect(listed.description).toBe(
      'Then change it with y_update or z_delete. Not served on this address: ' +
        '`y_update`, `z_delete` (served on https://example.test/pro); ' +
        '`gone_tool` (not served by this deployment).'
    );
  });

  it('points a read at the executor where its curated tool is not served', () => {
    runOnView(viewServing('api_call_operation'), () => {
      const text = describeOperation(
        'chain_loyalty_membership_types_list'
      ).text;
      expect(text).toContain(
        'The curated tool `memberships_list_types` covers this, but this address does not serve it (it is served on https://example.test/pro); here, use `api_call_operation`.'
      );
      expect(text).toContain(
        'Auth: signed-in user required (the app this connection runs in signs it in).'
      );
    });
  });
});
