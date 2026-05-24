// Message sanitizer — fixes orphan tool_use/tool_result after compression
// Enforces structural validity of the message array before sending to API.

interface ToolCallInfo {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

interface Message {
  role: string;
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

export function sanitizeMessages(messages: Message[]): Message[] {
  // Collect all tool_use IDs from assistant messages
  const toolUseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls as ToolCallInfo[]) {
        if (tc?.id) toolUseIds.add(tc.id);
      }
    }
  }

  // Collect all tool_result IDs from tool messages
  const toolResultIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.tool_call_id) {
      toolResultIds.add(msg.tool_call_id);
    }
  }

  // Find index of the last assistant message — tool_calls in this message are
  // considered "pending" (not yet answered) and must be preserved, since the
  // conversation hasn't continued past them yet.
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }

  const result: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'tool' && msg.tool_call_id) {
      // Drop orphan tool_result (no matching tool_use)
      if (!toolUseIds.has(msg.tool_call_id)) continue;
    }

    if (msg.role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls)) {
      // Only strip orphan tool_calls if a LATER message exists (conversation
      // continued past this assistant turn). If this IS the last assistant
      // message, its tool_calls are pending — keep them all.
      const isLastAssistant = i === lastAssistantIdx;

      if (isLastAssistant) {
        result.push(msg);
        continue;
      }

      // Filter out orphan tool_use blocks (no matching tool_result)
      const validCalls = (msg.tool_calls as ToolCallInfo[]).filter(
        tc => tc?.id && toolResultIds.has(tc.id)
      );

      if (validCalls.length !== (msg.tool_calls as ToolCallInfo[]).length) {
        // Some tool calls were orphaned — rebuild the message
        if (validCalls.length === 0 && !msg.content) {
          // Entire message was orphaned tool calls with no text — drop it
          continue;
        }
        result.push({
          ...msg,
          tool_calls: validCalls.length > 0 ? validCalls : undefined
        });
        continue;
      }
    }

    result.push(msg);
  }

  // Enforce role alternation: merge consecutive same-role messages
  return mergeConsecutiveSameRole(result);
}

function mergeConsecutiveSameRole(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;

  const result: Message[] = [messages[0]];

  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1];
    const curr = messages[i];

    // System messages are never merged
    if (curr.role === 'system' || prev.role === 'system') {
      result.push(curr);
      continue;
    }

    // Tool messages have their own identity via tool_call_id, don't merge
    if (curr.role === 'tool' || prev.role === 'tool') {
      result.push(curr);
      continue;
    }

    if (prev.role === curr.role) {
      // Merge consecutive user-user or assistant-assistant
      const prevContent = prev.content || '';
      const currContent = curr.content || '';
      const merged: Message = {
        ...prev,
        content: prevContent && currContent
          ? `${prevContent}\n\n${currContent}`
          : prevContent || currContent || null
      };

      // If merging assistant messages, combine tool_calls
      if (curr.role === 'assistant' && curr.tool_calls) {
        merged.tool_calls = [
          ...(prev.tool_calls || []),
          ...curr.tool_calls
        ];
      }

      result[result.length - 1] = merged;
    } else {
      result.push(curr);
    }
  }

  return result;
}
