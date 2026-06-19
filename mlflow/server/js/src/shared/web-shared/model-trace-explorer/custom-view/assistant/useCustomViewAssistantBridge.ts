import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { A2uiMessage } from '@a2ui/web_core/v0_9';

import { useAssistant, useRegisterAssistantContext } from '@mlflow/mlflow/src/assistant';

import {
  type AgentTraceData,
  buildAgentDataSnapshot,
  buildCustomViewAuthoringGuide,
  CUSTOM_VIEW_SPEC_FENCE,
} from '../agent/buildAgentPrompt';

// Pulls the A2UI spec out of an assistant chat reply: the assistant is told (via
// context) to wrap the spec in a ```mlflow-custom-view fence so we never confuse
// it with an unrelated ```json code block in a normal answer.
const extractSpecFromMessage = (content: string): string | undefined => {
  const fenced = content.match(new RegExp('```' + CUSTOM_VIEW_SPEC_FENCE + '\\s*([\\s\\S]*?)```', 'i'));
  return fenced?.[1]?.trim() || undefined;
};

export type CustomViewAssistantBridge = {
  // Whether MLflow Assistant is usable here (local server + completed setup).
  isAvailable: boolean;
  // True once the user has opened the assistant for authoring at least once.
  authoringEnabled: boolean;
  // Open the assistant, enable authoring context, and prime the conversation.
  openAssistant: () => void;
  // The latest error from applying an assistant-produced spec, if any.
  applyError?: string;
};

/**
 * Bridges the custom view to MLflow Assistant (frontend-capture):
 * - registers the A2UI authoring guide + current template + trace snapshot as
 *   page context (so the assistant knows how to produce a view spec),
 * - opens the assistant panel on demand, and
 * - watches the chat stream for a finalized reply containing the spec fence,
 *   handing the extracted JSON to `onSpec` (which validates + applies it).
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
  const { isLocalServer, setupComplete, openPanel, sendMessage, messages } = assistant;

  const [authoringEnabled, setAuthoringEnabled] = useState(false);
  const [applyError, setApplyError] = useState<string | undefined>(undefined);

  // Assistant messages we've already applied, so a re-render (or a follow-up
  // reply) never re-applies the same spec.
  const appliedMessageIdsRef = useRef<Set<string>>(new Set());

  // Keep the latest onSpec without making the watch effect depend on it.
  const onSpecRef = useRef(onSpec);
  onSpecRef.current = onSpec;

  const isAvailable = isLocalServer && setupComplete;

  // Register the authoring context only after the user opts in (avoids polluting
  // unrelated assistant usage). The guide is static; the per-trace snapshot and
  // current spec ride in their own fields.
  const authoringContext = useMemo(() => {
    if (!authoringEnabled) {
      return undefined;
    }
    return {
      guide: buildCustomViewAuthoringGuide(),
      currentTemplate: currentTemplate && currentTemplate.length > 0 ? JSON.stringify(currentTemplate) : null,
      traceSample: JSON.stringify(buildAgentDataSnapshot(data)),
    };
  }, [authoringEnabled, currentTemplate, data]);

  useRegisterAssistantContext('customViewAuthoring', authoringContext);

  const openAssistant = useCallback(() => {
    setApplyError(undefined);
    setAuthoringEnabled(true);
    openPanel();
    sendMessage(
      "Help me build or update the custom trace view for this experiment. I'll describe the view I want next.",
    );
  }, [openPanel, sendMessage]);

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

  return { isAvailable, authoringEnabled, openAssistant, applyError };
};
