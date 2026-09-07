/**
 * Resolves subagent thinking-level inheritance and overrides. Spawning uses
 * this helper to patch the child session without leaking invalid caller input.
 */
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeThinkLevel, type ThinkLevel } from "../../../auto-reply/thinking.shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

/**
 * Resolved inheritance for one spawn. `initialSessionPatch` is the wire-shaped
 * result both spawn paths consume: hidden spreads it into the child row patch,
 * visible forwards the level to atomic `sessions.create`. It stays empty when
 * nothing is inherited so the child keeps its own configured/model default.
 */
export type SubagentThinkingPlan =
  | { status: "error"; thinkingCandidateRaw: string }
  | {
      status: "ok";
      thinkingOverride?: ThinkLevel;
      initialSessionPatch: { thinkingLevel?: ThinkLevel };
    };

/** Resolves subagent thinking override and initial session patch from caller/agent config. */
export function resolveSubagentThinkingOverride(params: {
  cfg: OpenClawConfig;
  requesterAgentConfig?: unknown;
  targetAgentConfig?: unknown;
  thinkingOverrideRaw?: string;
  callerThinkingRaw?: string;
}): SubagentThinkingPlan {
  const requesterSubagents = asOptionalObjectRecord(
    asOptionalObjectRecord(params.requesterAgentConfig)?.subagents,
  );
  const targetSubagents = asOptionalObjectRecord(
    asOptionalObjectRecord(params.targetAgentConfig)?.subagents,
  );
  const defaultSubagents = asOptionalObjectRecord(params.cfg.agents?.defaults?.subagents);
  const resolvedThinkingDefaultRaw =
    normalizeOptionalString(requesterSubagents?.thinking) ??
    normalizeOptionalString(targetSubagents?.thinking) ??
    normalizeOptionalString(defaultSubagents?.thinking);

  const overrideCandidateRaw = params.thinkingOverrideRaw || resolvedThinkingDefaultRaw;
  if (overrideCandidateRaw) {
    const normalizedThinking = normalizeThinkLevel(overrideCandidateRaw);
    if (!normalizedThinking) {
      return {
        status: "error" as const,
        thinkingCandidateRaw: overrideCandidateRaw,
      };
    }

    return {
      status: "ok" as const,
      thinkingOverride: normalizedThinking,
      initialSessionPatch: {
        thinkingLevel: normalizedThinking,
      },
    };
  }

  if (!params.callerThinkingRaw) {
    return {
      status: "ok" as const,
      thinkingOverride: undefined,
      initialSessionPatch: {},
    };
  }

  const normalizedThinking = normalizeThinkLevel(params.callerThinkingRaw);
  if (!normalizedThinking) {
    return {
      status: "ok" as const,
      thinkingOverride: undefined,
      initialSessionPatch: {},
    };
  }

  return {
    status: "ok" as const,
    thinkingOverride: undefined,
    initialSessionPatch: {
      thinkingLevel: normalizedThinking,
    },
  };
}
