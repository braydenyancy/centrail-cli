import type { ParsedUsageEvent } from "@centrail/parsers";

// The parser event contains local-only context used for Git attribution.
// Keep the network shape separate and explicit so a parser field can never
// become an upload merely because it was added to ParsedUsageEvent.
export type WireUsageEvent = {
  externalId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheWriteTokens?: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  occurredAt: string;
};

export function toWireUsageEvent(event: ParsedUsageEvent): WireUsageEvent {
  return {
    externalId: event.externalId,
    model: event.model,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheCreationTokens: event.cacheCreationTokens,
    ...(event.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: event.cacheWriteTokens }),
    cacheCreation5mTokens: event.cacheCreation5mTokens,
    cacheCreation1hTokens: event.cacheCreation1hTokens,
    occurredAt: event.occurredAt.toISOString(),
  };
}
