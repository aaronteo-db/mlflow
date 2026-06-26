import { describe, test, expect } from '@jest/globals';

import { validateAndPrepareMessages } from './validateA2uiMessages';

const PREP = { surfaceId: 'surface-x', catalogId: 'catalog-x' };

// Pulls the flattened components out of the single kept updateComponents message.
const getComponents = (messages: unknown[]): Record<string, unknown>[] => {
  const message = messages.find(
    (m): m is Record<string, unknown> => Boolean(m) && typeof m === 'object' && 'updateComponents' in (m as object),
  );
  const payload = (message?.updateComponents ?? {}) as Record<string, unknown>;
  return (payload.components ?? []) as Record<string, unknown>[];
};

describe('validateAndPrepareMessages', () => {
  test('normalizes a nested "props" object onto the component and validates', () => {
    const raw = {
      messages: [
        {
          version: 'v0.9',
          updateComponents: {
            surfaceId: 'main',
            components: [
              { id: 'root', component: 'Column', props: { children: ['card1'] } },
              { id: 'card1', component: 'Card', props: { child: 'text1' } },
              { id: 'text1', component: 'Text', props: { text: 'hi' } },
            ],
          },
        },
      ],
    };

    const result = validateAndPrepareMessages(raw, PREP);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const card = getComponents(result.messages).find((c) => c.id === 'card1');
    // The nested prop is hoisted to the top level and the `props` key is dropped.
    expect(card?.child).toBe('text1');
    expect(card && 'props' in card).toBe(false);
  });

  test('rewrites the surfaceId on kept messages', () => {
    const raw = {
      messages: [
        {
          version: 'v0.9',
          updateComponents: {
            surfaceId: 'main',
            components: [{ id: 'root', component: 'Text', props: { text: 'hi' } }],
          },
        },
      ],
    };

    const result = validateAndPrepareMessages(raw, PREP);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const updateMessage = result.messages.find(
      (m): m is Record<string, unknown> => Boolean(m) && typeof m === 'object' && 'updateComponents' in (m as object),
    );
    expect((updateMessage?.updateComponents as Record<string, unknown>).surfaceId).toBe('surface-x');
  });

  test('still rejects a component that is invalid in either shape', () => {
    const raw = {
      messages: [
        {
          version: 'v0.9',
          updateComponents: {
            surfaceId: 'main',
            // Card requires a `child`; none is present nested or flat.
            components: [{ id: 'root', component: 'Card' }],
          },
        },
      ],
    };

    const result = validateAndPrepareMessages(raw, PREP);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('child');
  });
});
