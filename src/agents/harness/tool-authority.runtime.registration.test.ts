import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReplyToolAuthorityOverlay } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { testing as replyTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { resolveFollowupRunToolAuthorityFingerprint } from "../../auto-reply/reply/reply-tool-authority.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import { createDeferredEmbeddedRunLifecycleManager } from "../embedded-agent-runner/run/deferred-lifecycle-owner.js";
import {
  abortEmbeddedAgentRun,
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunActive,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  setActiveEmbeddedRun,
} from "../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle, testing } from "../embedded-agent-runner/runs.test-support.js";
import { getGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import { withPreparedEmbeddedRunToolAuthority } from "./tool-authority.runtime.js";

const REGISTRATION_MISMATCH = "embedded tool authority registration does not match its attempt";

// Parent turn: the attempt whose prepared tool authority is ambient while it
// spawns a child. Every identity component is synthetic.
const parent = {
  sessionId: "parent-session",
  sessionKey: "agent:main:main",
  sessionFile: "/tmp/parent-session.jsonl",
  agentId: "main",
  runId: "parent-run",
  config: {},
  workspaceDir: "/tmp/authority-workspace",
  provider: "anthropic",
  modelId: "claude-opus-4-7",
  sandboxSessionKey: "agent:main:main",
  senderIsOwner: true,
  messageProvider: "webchat",
  traceAuthorized: false,
};

// Visible child: sessions_spawn visible=true creates a dashboard session and
// its first turn is dispatched from inside the parent's tool call.
const child = {
  sessionId: "child-session",
  sessionKey: "agent:main:dashboard:11111111-2222-4333-8444-555555555555",
  sessionFile: "/tmp/child-session.jsonl",
  agentId: "main",
  runId: "child-run",
};

const own: ReplyToolAuthorityOverlay = {
  senderIsOwner: true,
  disableTools: false,
  traceAuthorized: false,
  messageProvider: "webchat",
};

async function admitted<T>(
  attempt: typeof parent,
  run: (context: {
    admittedRunContext: Awaited<ReturnType<ReturnType<typeof prepareAgentRunAdmission>["admit"]>>;
  }) => Promise<T>,
) {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    operationalRunInstance: createOperationalRunInstanceRef(attempt.runId),
    facts: {
      agentId: attempt.agentId,
      runId: attempt.runId,
      ingress: { kind: "system", state: "present", boundary: "tool-authority-registration-test" },
    },
  });
  try {
    return await run({
      admittedRunContext: await admission.admit("embedded", "authority-registration-test"),
    });
  } finally {
    admission.close();
  }
}

/** Runs `body` inside a prepared attempt's authority scope. */
async function prepared<T>(
  attempt: typeof parent,
  body: (prepared: { toolAuthorityFingerprint?: string }) => Promise<T>,
) {
  return admitted(attempt, ({ admittedRunContext }) =>
    withPreparedEmbeddedRunToolAuthority({ admittedRunContext }, attempt, undefined, body),
  );
}

function registration(
  attempt: typeof parent,
  fingerprint: string | undefined,
  overrides: {
    sessionId?: string;
    sessionKey?: string;
    sessionFile?: string;
    agentId?: string;
    runId?: string;
    toolAuthorityFingerprint?: string;
  } = {},
) {
  const handle = createEmbeddedRunHandle({
    runId: overrides.runId ?? attempt.runId,
    toolAuthorityFingerprint: overrides.toolAuthorityFingerprint ?? fingerprint,
    queueMessage: vi.fn(async () => {}),
  });
  return {
    handle,
    publish: () =>
      setActiveEmbeddedRun(
        overrides.sessionId ?? attempt.sessionId,
        handle,
        overrides.sessionKey ?? attempt.sessionKey,
        overrides.sessionFile ?? attempt.sessionFile,
        overrides.agentId ?? attempt.agentId,
      ),
  };
}

afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  replyTesting.resetReplyRunRegistry();
  vi.restoreAllMocks();
});

describe("embedded tool authority registration identity", () => {
  it("accepts a Claude registration that matches its prepared attempt", async () => {
    await prepared(parent, async ({ toolAuthorityFingerprint }) => {
      const { handle, publish } = registration(parent, toolAuthorityFingerprint);
      expect(publish).not.toThrow();
      expect(isEmbeddedAgentRunActive(parent.sessionId)).toBe(true);
      await expect(
        queueEmbeddedAgentMessageWithOutcomeAsync(parent.sessionId, "Continue", {
          isInboundUserMessage: true,
          toolAuthorityOverlay: own,
          taskSuggestionDeliveryMode: undefined,
        }),
      ).resolves.toMatchObject({ queued: true });
      expect(handle.queueMessage).toHaveBeenCalledOnce();
      clearActiveEmbeddedRun(parent.sessionId, handle, parent.sessionKey, parent.sessionFile);
    });
  });

  it.each([
    { field: "sessionId", overrides: { sessionId: "other-session" } },
    { field: "sessionKey", overrides: { sessionKey: "agent:main:other" } },
    { field: "sessionFile", overrides: { sessionFile: "/tmp/other-session.jsonl" } },
    { field: "agentId", overrides: { agentId: "other-agent" } },
    { field: "runId", overrides: { runId: "other-run" } },
    {
      field: "toolAuthorityFingerprint",
      overrides: {
        toolAuthorityFingerprint: resolveFollowupRunToolAuthorityFingerprint({
          toolsAllow: [],
          run: {
            ...parent,
            model: parent.modelId,
            runtimePolicySessionKey: parent.sandboxSessionKey,
          },
        }),
      },
    },
  ])("rejects a registration whose $field differs from the attempt", async ({ overrides }) => {
    await prepared(parent, async ({ toolAuthorityFingerprint }) => {
      const { publish } = registration(parent, toolAuthorityFingerprint, overrides);
      expect(publish).toThrow(REGISTRATION_MISMATCH);
      expect(isEmbeddedAgentRunActive(overrides.sessionId ?? parent.sessionId)).toBe(false);
    });
  });

  it("does not let a valid registration handle be reused by a different attempt", async () => {
    const successor = { ...parent, runId: "successor-run" };
    await prepared(parent, async ({ toolAuthorityFingerprint }) => {
      const { handle, publish } = registration(parent, toolAuthorityFingerprint);
      publish();
      await prepared(successor, async () => {
        expect(() =>
          setActiveEmbeddedRun(
            parent.sessionId,
            handle,
            parent.sessionKey,
            parent.sessionFile,
            parent.agentId,
          ),
        ).toThrow(REGISTRATION_MISMATCH);
      });
      clearActiveEmbeddedRun(parent.sessionId, handle, parent.sessionKey, parent.sessionFile);
    });
  });

  it("publishes a nested visible child's CLI owner without the parent attempt's binding", async () => {
    // sessions_spawn visible=true -> in-process sessions.create -> inline
    // chat.send -> reply lane. The lane runs the child's turn inside the
    // parent's AsyncLocalStorage snapshot, so the parent's prepared authority
    // is ambient when the child's claude-cli candidate publishes its CLI owner.
    await prepared(parent, async ({ toolAuthorityFingerprint }) => {
      const parentHandle = registration(parent, toolAuthorityFingerprint);
      parentHandle.publish();
      const childLane = `session:${child.sessionKey}`;
      const manager = await enqueueCommandInLane(childLane, async () => {
        // Precondition for the regression: the parent's binding leaked into the
        // lane. Asserted deliberately so this test cannot pass vacuously; if the
        // lane ever stops inheriting the enqueuer's caller identity, revisit it.
        expect(getGatewayToolCallerIdentity()?.embeddedRunToolAuthorityBinding).toBeTypeOf(
          "function",
        );
        const lifecycle = createDeferredEmbeddedRunLifecycleManager(child);
        lifecycle.handoffToCli();
        return lifecycle;
      });
      try {
        expect(isEmbeddedAgentRunActive(child.sessionId)).toBe(true);
        expect(isEmbeddedAgentRunActive(parent.sessionId)).toBe(true);
        // The CLI owner claims cancellation for the child run only; the parent's
        // caller evidence and hash confer nothing on it.
        await expect(
          queueEmbeddedAgentMessageWithOutcomeAsync(child.sessionId, "Use the release branch", {
            isInboundUserMessage: true,
            toolAuthorityOverlay: own,
            toolAuthorityFingerprint: parentHandle.handle.toolAuthorityFingerprint,
            taskSuggestionDeliveryMode: undefined,
          }),
        ).resolves.toMatchObject({ queued: false, reason: "tool_authority_mismatch" });
        expect(parentHandle.handle.queueMessage).not.toHaveBeenCalled();
        expect(abortEmbeddedAgentRun(child.sessionId)).toBe(true);
        expect(manager.signal.aborted).toBe(true);
      } finally {
        await manager.complete();
        clearActiveEmbeddedRun(
          parent.sessionId,
          parentHandle.handle,
          parent.sessionKey,
          parent.sessionFile,
        );
      }
      expect(isEmbeddedAgentRunActive(child.sessionId)).toBe(false);
    });
  });

  it("keeps a same-run CLI handoff working after its embedded attempt closes", async () => {
    // Embedded-to-CLI fallback within one logical turn: the embedded attempt's
    // authority scope has exited before the CLI candidate publishes its owner,
    // so no caller identity is ambient here. This guards the fallback ordering;
    // it does not exercise the foreign-identity exit above.
    await prepared(parent, async ({ toolAuthorityFingerprint }) => {
      const { handle, publish } = registration(parent, toolAuthorityFingerprint);
      publish();
      clearActiveEmbeddedRun(parent.sessionId, handle, parent.sessionKey, parent.sessionFile);
    });
    const manager = createDeferredEmbeddedRunLifecycleManager(parent);
    manager.handoffToCli();
    expect(isEmbeddedAgentRunActive(parent.sessionId)).toBe(true);
    await manager.complete();
    expect(isEmbeddedAgentRunActive(parent.sessionId)).toBe(false);
  });
});
