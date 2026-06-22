import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { A2uiMessage } from '@a2ui/web_core/v0_9';

import {
  sendMessageStream,
  useAssistant,
  useAssistantPageContextActions,
  useRegisterAssistantContext,
} from '@mlflow/mlflow/src/assistant';

import {
  type AgentTraceData,
  buildAgentDataSnapshot,
  buildCustomViewAuthoringGuide,
  CUSTOM_VIEW_SPEC_FENCE,
} from '../agent/buildAgentPrompt';

// Pulls the A2UI spec out of an assistant reply: the assistant is told (via
// context) to wrap the spec in a ```mlflow-custom-view fence so we never confuse
// it with an unrelated ```json code block in a normal answer.
//
// The spec JSON can itself contain literal ``` sequences inside string values
// (e.g. a Markdown/KeyValueViewer value with a fenced code block), so we must NOT
// stop at the first ```. We slice from the opening fence to the LAST ``` in the
// reply: the real closing fence is always the final triple-backtick (the guide
// forbids content after the spec block), while the inner ``` sit inside JSON
// strings earlier in the payload.
const extractSpecFromMessage = (content: string): string | undefined => {
  const open = content.match(new RegExp('```' + CUSTOM_VIEW_SPEC_FENCE + '[^\\n]*\\r?\\n', 'i'));
  if (!open || open.index === undefined) {
    return undefined;
  }
  const body = content.slice(open.index + open[0].length);
  const close = body.lastIndexOf('```');
  if (close === -1) {
    // Closing fence not streamed yet (or omitted); nothing to apply.
    return undefined;
  }
  return body.slice(0, close).trim() || undefined;
};

// A single in-flight headless (background) spec request: the spec JSON resolves
// on completion, and `cancel` closes the underlying stream (used to abort stale
// per-trace regenerations when the user cycles quickly).
export type AssistantSpecRequest = {
  specPromise: Promise<string>;
  cancel: () => void;
};

export type CustomViewAssistantBridge = {
  // Whether MLflow Assistant is usable here (local server + completed setup).
  isAvailable: boolean;
  // True once the user has opened the assistant for authoring at least once.
  authoringEnabled: boolean;
  // Open the assistant for authoring. When `prompt` is given it is sent as the
  // first message; otherwise the panel just opens for free-form editing.
  openAssistant: (prompt?: string) => void;
  // Fire a silent, headless authoring request (separate session, no chat UI) and
  // resolve the extracted A2UI spec. Used for per-trace regeneration. The
  // `referenceTemplate` (the stored design) is handed back to the assistant so it
  // reproduces the SAME layout for the new trace's data.
  requestSpec: (args: {
    instruction: string;
    data: AgentTraceData;
    referenceTemplate?: A2uiMessage[];
  }) => AssistantSpecRequest;
  // The latest error from applying an assistant-produced spec, if any.
  applyError?: string;
  // True while the assistant chat is actively streaming a reply. Used by the
  // host to show a loading skeleton during the FIRST (chat-driven) build, when
  // there is no active view yet (per-trace regeneration uses its own headless
  // request and tracks loading separately).
  isStreaming: boolean;
};

/**
 * Bridges the custom view to MLflow Assistant (frontend-capture):
 * - registers the A2UI authoring guide + current template + trace snapshot as
 *   page context (so the assistant knows how to produce a view spec),
 * - opens the assistant panel on demand (optionally seeding the first message),
 * - watches the chat stream for a finalized reply containing the spec fence,
 *   handing the extracted JSON to `onSpec` (which validates + applies it), and
 * - exposes `requestSpec` for silent, headless per-trace regeneration.
 *
 * `onSpec` is called with the extracted spec JSON and the user's triggering
 * request (used as the panel's instruction for per-trace regeneration). It
 * returns an error message when the spec could not be applied, or undefined on
 * success; the bridge surfaces it via `applyError`.
 */
export const useCustomViewAssistantBridge = ({
  data,
  currentTemplate,
  onSpec,
}: {
  data: AgentTraceData;
  currentTemplate?: A2uiMessage[];
  onSpec: (jsonText: string, instruction: string) => string | undefined;
}): CustomViewAssistantBridge => {
  const assistant = useAssistant();
  const { isLocalServer, setupComplete, openPanel, sendMessage, messages, isStreaming } = assistant;
  const { getContext, setContext } = useAssistantPageContextActions();

  const [authoringEnabled, setAuthoringEnabled] = useState(false);
  const [applyError, setApplyError] = useState<string | undefined>(undefined);

  // Assistant messages we've already applied, so a re-render (or a follow-up
  // reply) never re-applies the same spec.
  const appliedMessageIdsRef = useRef<Set<string>>(new Set());

  // Keep the latest onSpec without making the watch effect depend on it.
  const onSpecRef = useRef(onSpec);
  onSpecRef.current = onSpec;

  const isAvailable = isLocalServer && setupComplete;

  // Builds the authoring context (static guide + per-trace snapshot + current
  // spec). Shared by the declarative registration below and the synchronous
  // registration in `openAssistant` so both stay in sync.
  const buildAuthoringContext = useCallback(
    () => ({
      guide: buildCustomViewAuthoringGuide(),
      currentTemplate: currentTemplate && currentTemplate.length > 0 ? JSON.stringify(currentTemplate) : null,
      traceSample: JSON.stringify(buildAgentDataSnapshot(data)),
    }),
    [currentTemplate, data],
  );

  // Register the authoring context only after the user opts in (avoids polluting
  // unrelated assistant usage). The guide is static; the per-trace snapshot and
  // current spec ride in their own fields.
  const authoringContext = useMemo(
    () => (authoringEnabled ? buildAuthoringContext() : undefined),
    [authoringEnabled, buildAuthoringContext],
  );

  useRegisterAssistantContext('customViewAuthoring', authoringContext);

  const openAssistant = useCallback(
    (prompt?: string) => {
      setApplyError(undefined);
      setAuthoringEnabled(true);
      // Register the authoring context SYNCHRONOUSLY before sending: sendMessage
      // reads the page context immediately (same tick), but the declarative
      // useRegisterAssistantContext effect above would only run after the next
      // render. Without this, the seeded first message goes out without the
      // authoring guide and the assistant answers normally instead of emitting
      // a custom-view spec.
      setContext('customViewAuthoring', buildAuthoringContext());
      openPanel();
      if (prompt && prompt.trim()) {
        sendMessage(prompt.trim());
      }
    },
    [openPanel, sendMessage, setContext, buildAuthoringContext],
  );

  // Silent per-trace regeneration: drive the assistant backend directly (no chat
  // UI, fresh session) so it never pollutes the user's visible conversation. The
  // authoring guide + the CURRENT trace's snapshot ride in the request context.
  // The `referenceTemplate` (the stored design) is passed as `currentTemplate` so
  // the model reproduces the same layout — the guide instructs it to regenerate
  // ALL data/span-ids from this trace's snapshot rather than reuse the
  // reference's (which belong to a different trace).
  const requestSpec = useCallback(
    ({
      instruction,
      data: traceData,
      referenceTemplate,
    }: {
      instruction: string;
      data: AgentTraceData;
      referenceTemplate?: A2uiMessage[];
    }): AssistantSpecRequest => {
      const pageContext = getContext();
      const experimentId = typeof pageContext['experimentId'] === 'string' ? pageContext['experimentId'] : undefined;
      const context = {
        ...pageContext,
        customViewAuthoring: {
          guide: buildCustomViewAuthoringGuide(),
          currentTemplate:
            referenceTemplate && referenceTemplate.length > 0 ? JSON.stringify(referenceTemplate) : null,
          traceSample: JSON.stringify(buildAgentDataSnapshot(traceData)),
        },
      };

      let settled = false;
      let accumulated = '';
      let eventSource: EventSource | null = null;
      let cancelled = false;

      const specPromise = new Promise<string>((resolve, reject) => {
        sendMessageStream(
          { message: instruction, experiment_id: experimentId, context },
          {
            onMessage: (text) => {
              accumulated += text;
            },
            onError: (error) => {
              if (!settled) {
                settled = true;
                reject(new Error(error));
              }
            },
            onDone: () => {
              if (settled) {
                return;
              }
              settled = true;
              const spec = extractSpecFromMessage(accumulated);
              if (spec) {
                resolve(spec);
              } else {
                reject(new Error('MLflow Assistant did not return a custom view spec for this trace.'));
              }
            },
            onInterrupted: () => {
              if (!settled) {
                settled = true;
                reject(new Error('The request was cancelled.'));
              }
            },
          },
        )
          .then((result) => {
            eventSource = result.eventSource;
            if (cancelled) {
              eventSource?.close();
            }
          })
          .catch((error) => {
            if (!settled) {
              settled = true;
              reject(error instanceof Error ? error : new Error('Failed to reach MLflow Assistant.'));
            }
          });
      });

      const cancel = () => {
        cancelled = true;
        eventSource?.close();
      };

      return { specPromise, cancel };
    },
    [getContext],
  );

  // Watch the chat stream for a completed assistant reply carrying a spec.
  useEffect(() => {
    if (!authoringEnabled) {
      return;
    }
    // Track the most recent user request so an applied spec can be re-generated
    // per trace from the same instruction.
    let lastUserContent = '';
    for (const message of messages) {
      if (message.role === 'user') {
        lastUserContent = message.content;
        continue;
      }
      if (message.role !== 'assistant' || message.isStreaming || appliedMessageIdsRef.current.has(message.id)) {
        continue;
      }
      const spec = extractSpecFromMessage(message.content);
      if (!spec) {
        continue;
      }
      appliedMessageIdsRef.current.add(message.id);
      const error = onSpecRef.current(spec, lastUserContent || 'MLflow Assistant view');
      setApplyError(error);
    }
  }, [authoringEnabled, messages]);

  return { isAvailable, authoringEnabled, openAssistant, requestSpec, applyError, isStreaming };
};
