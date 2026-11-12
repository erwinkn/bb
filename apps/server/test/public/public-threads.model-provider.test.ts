import {
  provisionHostMock,
  resumeHostMock,
} from "./public-thread-test-harness.js";

import { upsertProjectExecutionDefaults } from "@bb/db";
import { threadSchema } from "@bb/domain";
import { availableModelFixture } from "../helpers/available-models.js";
import { registerProviderHostRpcResponder } from "../helpers/host-rpc.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";
import { beforeEach, describe, expect, it } from "vitest";

type ResponderArgs = Parameters<typeof registerProviderHostRpcResponder>[1];

function seedCodexDefaultProject(
  harness: TestAppHarness,
  path: string,
  catalogs: Partial<
    Pick<ResponderArgs, "modelErrorsByProviderId" | "modelsByProviderId">
  > = {},
) {
  const { host, session } = seedHostSession(harness.deps);
  registerProviderHostRpcResponder(harness, {
    hostId: host.id,
    sessionId: session.id,
    ...(catalogs.modelErrorsByProviderId !== undefined
      ? { modelErrorsByProviderId: catalogs.modelErrorsByProviderId }
      : {}),
    modelsByProviderId: catalogs.modelsByProviderId ?? {
      codex: {
        models: [availableModelFixture({ model: "gpt-5", isDefault: true })],
        selectedOnlyModels: [],
      },
      "claude-code": {
        models: [
          availableModelFixture({ model: "claude-opus-5-5", isDefault: true }),
        ],
        selectedOnlyModels: [],
      },
    },
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path,
  });
  upsertProjectExecutionDefaults(harness.db, {
    projectId: project.id,
    providerId: "codex",
    model: "gpt-5",
    serviceTier: "fast",
    reasoningLevel: "high",
    permissionMode: "accept-edits",
  });
  return { environment, project };
}

function spawnThread(
  harness: TestAppHarness,
  body: { environmentId: string; projectId: string } & Record<string, unknown>,
) {
  const { environmentId, ...rest } = body;
  return harness.app.request("/api/v1/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      origin: "cli",
      input: [{ type: "text", text: "Hello" }],
      environment: { type: "reuse", environmentId },
      ...rest,
    }),
  });
}

describe("thread spawn provider ids (T165)", () => {
  beforeEach(() => {
    provisionHostMock.mockReset();
    resumeHostMock.mockReset();
  });

  it("rejects an unknown provider id and lists the valid ones", async () => {
    await withTestHarness(async (harness) => {
      const { environment, project } = seedCodexDefaultProject(
        harness,
        "/tmp/thread-provider-unknown",
      );

      const response = await spawnThread(harness, {
        environmentId: environment.id,
        projectId: project.id,
        providerId: "claude",
        model: "claude-opus-5-5",
      });

      expect(response.status).toBe(400);
      const body = (await readJson(response)) as {
        code: string;
        message: string;
      };
      expect(body.code).toBe("unknown_provider");
      expect(body.message).toContain('Unknown provider "claude"');
      expect(body.message).toContain("claude-code");
    });
  });

  it("takes the provider from the model when no provider is given", async () => {
    await withTestHarness(async (harness) => {
      const { environment, project } = seedCodexDefaultProject(
        harness,
        "/tmp/thread-provider-from-model",
      );

      const response = await spawnThread(harness, {
        environmentId: environment.id,
        projectId: project.id,
        model: "claude-opus-5-5",
      });

      expect(response.status).toBe(201);
      const thread = threadSchema.parse(await readJson(response));
      expect(thread.providerId).toBe("claude-code");
    });
  });

  it("refuses a model that no provider offers when no provider is given", async () => {
    await withTestHarness(async (harness) => {
      const { environment, project } = seedCodexDefaultProject(
        harness,
        "/tmp/thread-provider-no-model",
      );

      const response = await spawnThread(harness, {
        environmentId: environment.id,
        projectId: project.id,
        model: "claude-nonexistent",
      });

      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "model_not_offered",
      });
    });
  });
  it("keeps the default provider when it offers the model", async () => {
    await withTestHarness(async (harness) => {
      const { environment, project } = seedCodexDefaultProject(
        harness,
        "/tmp/thread-provider-default-offers",
      );

      const response = await spawnThread(harness, {
        environmentId: environment.id,
        projectId: project.id,
        model: "gpt-5",
      });

      expect(response.status).toBe(201);
      const thread = threadSchema.parse(await readJson(response));
      expect(thread.providerId).toBe("codex");
    });
  });

  it("asks for a provider when several offer the model", async () => {
    await withTestHarness(async (harness) => {
      const shared = {
        models: [availableModelFixture({ model: "shared", isDefault: true })],
        selectedOnlyModels: [],
      };
      const { environment, project } = seedCodexDefaultProject(
        harness,
        "/tmp/thread-provider-ambiguous",
        {
          modelsByProviderId: {
            codex: {
              models: [availableModelFixture({ model: "gpt-5" })],
              selectedOnlyModels: [],
            },
            "claude-code": shared,
            pi: shared,
          },
        },
      );

      const response = await spawnThread(harness, {
        environmentId: environment.id,
        projectId: project.id,
        model: "shared",
      });

      expect(response.status).toBe(400);
      const body = (await readJson(response)) as {
        code: string;
        message: string;
      };
      expect(body.code).toBe("model_provider_ambiguous");
      expect(body.message).toContain("claude-code, pi");
    });
  });

  it("keeps the default provider when its catalog fails, even if another provider offers the model", async () => {
    await withTestHarness(async (harness) => {
      const { environment, project } = seedCodexDefaultProject(
        harness,
        "/tmp/thread-provider-catalog-down",
        {
          modelErrorsByProviderId: {
            codex: {
              errorCode: "provider_rpc_error",
              errorMessage: "Provider failed",
            },
          },
        },
      );

      const response = await spawnThread(harness, {
        environmentId: environment.id,
        projectId: project.id,
        model: "claude-opus-5-5",
      });

      expect(response.status).toBe(201);
      const thread = threadSchema.parse(await readJson(response));
      expect(thread.providerId).toBe("codex");
    });
  });

  it("ignores a model the app did not mark as chosen", async () => {
    await withTestHarness(async (harness) => {
      const { environment, project } = seedCodexDefaultProject(
        harness,
        "/tmp/thread-provider-app-sources",
      );

      const response = await spawnThread(harness, {
        environmentId: environment.id,
        projectId: project.id,
        origin: "app",
        model: "claude-opus-5-5",
        executionInputSources: {},
      });

      expect(response.status).toBe(201);
      const thread = threadSchema.parse(await readJson(response));
      expect(thread.providerId).toBe("codex");
    });
  });
});
