import { describe, test, expect } from '@jest/globals';

import type { A2uiMessage } from '@a2ui/web_core/v0_9';

import type { ModelTraceSpanNode } from '../ModelTrace.types';
import type { CustomViewData } from './customViewBuilders';
import { isBoundTemplate, resolveTemplate } from './resolveTemplate';

// Builds a minimal span node; only the fields resolveSpanRef reads are required.
const spanNode = (over: Partial<ModelTraceSpanNode>): ModelTraceSpanNode =>
  ({ key: 'k', title: 't', type: 'UNKNOWN', start: 0, end: 1, ...over }) as unknown as ModelTraceSpanNode;

const viewData: CustomViewData = {
  metrics: { status: 'OK', latency: '1.20s', totalTokens: '3,120', assessments: '1' },
  toolRows: [{ color: '#077A9D', cells: ['run_sql_query', '4', '100.00%', '38ms'] }],
  timelineRows: [{ label: 'agent', start: 0, end: 100, depth: 0 }],
  treeNodes: [
    {
      id: 'span-0',
      label: 'agent',
      icon: 'agent',
      hasException: false,
      isRootSpan: true,
      attributes: { type: 'AGENT', hasException: false, logLevel: 0, durationMs: 100 },
      children: [
        {
          id: 'span-1',
          label: 'run_sql_query',
          icon: 'wrench',
          hasException: false,
          isRootSpan: false,
          attributes: { type: 'TOOL', hasException: false, logLevel: 0, durationMs: 38 },
          children: [],
        },
      ],
    },
  ],
  assessmentItems: [{ name: 'Correctness', value: 'yes', rationale: 'looks right', source: 'LLM_JUDGE', sentiment: 'positive' }],
};

// nodeMap for "trace A": the TOOL span is span-1.
const nodeMapA: Record<string, ModelTraceSpanNode> = {
  'span-0': spanNode({ key: 'span-0', title: 'agent', type: 'AGENT', start: 0 }),
  'span-1': spanNode({ key: 'span-1', title: 'run_sql_query', type: 'TOOL', start: 10, parentId: 'span-0' }),
};

// nodeMap for "trace B": same roles, but the TOOL span has a DIFFERENT id.
const nodeMapB: Record<string, ModelTraceSpanNode> = {
  'spanB-7': spanNode({ key: 'spanB-7', title: 'agent', type: 'AGENT', start: 0 }),
  'spanB-9': spanNode({ key: 'spanB-9', title: 'run_sql_query', type: 'TOOL', start: 5, parentId: 'spanB-7' }),
};

const template: A2uiMessage[] = [
  {
    version: 'v0.9',
    updateComponents: {
      surfaceId: 'main',
      components: [
        { id: 'root', component: 'Column', children: ['stat', 'tbl', 'tree', 'board', 'fb'] },
        { id: 'stat', component: 'StatCard', value: { $source: 'metrics.latency' }, label: 'Latency' },
        { id: 'tbl', component: 'DataTable', columns: [{ label: 'Tool' }], rows: { $source: 'toolRows' } },
        { id: 'tree', component: 'TreeView', children: { $source: 'spanTree', panelItems: [{ type: 'input' }] } },
        { id: 'board', component: 'AssessmentBoard', children: { $source: 'assessments' } },
        { id: 'fb', component: 'FeedbackThumbsUpDownButtons', name: 'Helpful', spanId: { $spanRef: { type: 'TOOL' } } },
      ],
    },
  },
] as unknown as A2uiMessage[];

const componentsOf = (messages: A2uiMessage[]): Record<string, unknown>[] => {
  const message = messages.find(
    (m): m is Record<string, unknown> => Boolean(m) && typeof m === 'object' && 'updateComponents' in (m as object),
  );
  const payload = (message?.updateComponents ?? {}) as Record<string, unknown>;
  return (payload.components ?? []) as Record<string, unknown>[];
};
const byId = (components: Record<string, unknown>[], id: string) => components.find((c) => c.id === id);

describe('resolveTemplate', () => {
  test('resolves scalar, array, structural, and spanRef markers for the current trace', () => {
    const components = componentsOf(resolveTemplate(template, { viewData, nodeMap: nodeMapA }));

    // Scalar -> inline string from metrics.
    expect(byId(components, 'stat')?.value).toBe('1.20s');
    // Array -> inline the current trace's toolRows.
    expect(byId(components, 'tbl')?.rows).toEqual(viewData.toolRows);

    // Structural spanTree -> TreeView.children become materialized node ids, and
    // the TreeNode components are appended (with the span ids + panelItems).
    const tree = byId(components, 'tree');
    expect(Array.isArray(tree?.children)).toBe(true);
    const nodeIds = tree?.children as string[];
    expect(nodeIds.length).toBe(1); // one root node
    const rootNode = byId(components, nodeIds[0]);
    expect(rootNode?.component).toBe('TreeNode');
    expect(rootNode?.spanId).toBe('span-0');
    expect(rootNode?.panelItems).toEqual([{ type: 'input' }]);
    // Its nested child (span-1) is materialized too.
    const childId = (rootNode?.children as string[])[0];
    expect(byId(components, childId)?.spanId).toBe('span-1');

    // Structural assessments -> one AssessmentCard per item.
    const board = byId(components, 'board');
    const cardIds = board?.children as string[];
    expect(cardIds.length).toBe(1);
    expect(byId(components, cardIds[0])?.name).toBe('Correctness');

    // spanRef -> the current trace's first TOOL span id.
    expect(byId(components, 'fb')?.spanId).toBe('span-1');
  });

  test('re-targets a spanRef feedback control to the equivalent span in a different trace', () => {
    const a = componentsOf(resolveTemplate(template, { viewData, nodeMap: nodeMapA }));
    const b = componentsOf(resolveTemplate(template, { viewData, nodeMap: nodeMapB }));
    expect(byId(a, 'fb')?.spanId).toBe('span-1');
    // Same template, different trace -> the feedback binds to that trace's TOOL span.
    expect(byId(b, 'fb')?.spanId).toBe('spanB-9');
  });

  test('drops a spanId whose spanRef matches nothing in the trace', () => {
    const tmpl = [
      {
        version: 'v0.9',
        updateComponents: {
          surfaceId: 'main',
          components: [
            { id: 'root', component: 'FeedbackThumbsUpDownButtons', name: 'Helpful', spanId: { $spanRef: { type: 'RETRIEVER' } } },
          ],
        },
      },
    ] as unknown as A2uiMessage[];
    const components = componentsOf(resolveTemplate(tmpl, { viewData, nodeMap: nodeMapA }));
    expect(byId(components, 'root') && 'spanId' in byId(components, 'root')!).toBe(false);
  });

  test('filters timelineRows to a single span type via filterType', () => {
    const tmpl = [
      {
        version: 'v0.9',
        updateComponents: {
          surfaceId: 'main',
          components: [{ id: 'root', component: 'TimelineChart', rows: { $source: 'timelineRows', filterType: 'TOOL' } }],
        },
      },
    ] as unknown as A2uiMessage[];
    const rows = byId(componentsOf(resolveTemplate(tmpl, { viewData, nodeMap: nodeMapA })), 'root')?.rows as {
      label: string;
    }[];
    // nodeMapA has one TOOL span (run_sql_query) and one AGENT span; only the
    // tool span should survive the filter.
    expect(rows.map((r) => r.label)).toEqual(['run_sql_query']);
  });

  test('resolves the root spanRef', () => {
    const tmpl = [
      {
        version: 'v0.9',
        updateComponents: {
          surfaceId: 'main',
          components: [{ id: 'root', component: 'RadioGroup', name: 'X', options: [], spanId: { $spanRef: 'root' } }],
        },
      },
    ] as unknown as A2uiMessage[];
    const components = componentsOf(resolveTemplate(tmpl, { viewData, nodeMap: nodeMapA }));
    expect(byId(components, 'root')?.spanId).toBe('span-0');
  });

  test('passes a marker-free (legacy) template through unchanged', () => {
    const legacy = [
      {
        version: 'v0.9',
        updateComponents: { surfaceId: 'main', components: [{ id: 'root', component: 'StatCard', value: '42', label: 'X' }] },
      },
    ] as unknown as A2uiMessage[];
    expect(isBoundTemplate(legacy)).toBe(false);
    expect(isBoundTemplate(template)).toBe(true);
    const components = componentsOf(resolveTemplate(legacy, { viewData, nodeMap: nodeMapA }));
    expect(byId(components, 'root')?.value).toBe('42');
  });
});
