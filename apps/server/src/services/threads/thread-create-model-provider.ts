import { ApiError } from "../../errors.js";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { resolveSystemProviderModels } from "../system/execution-options.js";
import {
  resolveProjectExecutionDefaultsForCreate,
  type ResolvedProjectExecutionDefaultsForCreate,
} from "./project-execution-defaults.js";

interface ProviderModelLookupArgs {
  cwd?: string;
  hostId: string;
  model: string;
  providerId: string;
}

async function providerOffersModel(
  deps: LoggedWorkSessionDeps,
  args: ProviderModelLookupArgs,
  refreshStaleCatalog: boolean,
): Promise<boolean | null> {
  try {
    const catalog = await resolveSystemProviderModels(deps, {
      ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
      hostId: args.hostId,
      providerId: args.providerId,
      ...(refreshStaleCatalog ? { requiredModel: args.model } : {}),
    });
    const offered = [...catalog.models, ...catalog.selectedOnlyModels].some(
      (entry) => entry.model === args.model,
    );
    return offered || catalog.modelLoadError === null ? offered : null;
  } catch (error) {
    if (error instanceof ApiError) return null;
    throw error;
  }
}

async function resolveProviderForRequestedModel(
  deps: LoggedWorkSessionDeps,
  args: ProviderModelLookupArgs,
): Promise<string> {
  const defaultOffers = await providerOffersModel(deps, args, true);
  if (defaultOffers !== false) return args.providerId;
  const disabled = deps.providerRegistry.disabledProviderIds();
  const candidates = deps.providerRegistry
    .list()
    .map((entry) => entry.info)
    .filter(
      (info) =>
        info.id !== args.providerId && info.available && !disabled.has(info.id),
    )
    .map((info) => info.id);
  const offers = await Promise.all(
    candidates.map((providerId) =>
      providerOffersModel(deps, { ...args, providerId }, false),
    ),
  );
  const matches = candidates.filter((_, index) => offers[index] === true);
  const [onlyMatch] = matches;
  if (matches.length === 1 && onlyMatch !== undefined) return onlyMatch;
  if (matches.length > 1) {
    throw new ApiError(
      400,
      "model_provider_ambiguous",
      `Model "${args.model}" is offered by ${matches.join(", ")}. Name the provider explicitly (bb thread spawn --provider <id>).`,
    );
  }
  throw new ApiError(
    400,
    "model_not_offered",
    `No enabled provider offers model "${args.model}" (default provider: ${args.providerId}). Name the provider explicitly (bb thread spawn --provider <id>); \`bb provider models <id>\` lists each provider's models.`,
  );
}

export async function resolveCreateExecutionForModel(
  deps: LoggedWorkSessionDeps,
  args: {
    cwd?: string;
    execution: ResolvedProjectExecutionDefaultsForCreate;
    hostId: string | null;
    projectId: string;
  },
): Promise<ResolvedProjectExecutionDefaultsForCreate> {
  const { execution } = args;
  if (
    execution.providerRequested ||
    execution.requestedModel === null ||
    args.hostId === null
  ) {
    return execution;
  }
  const providerId = await resolveProviderForRequestedModel(deps, {
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
    hostId: args.hostId,
    model: execution.requestedModel,
    providerId: execution.providerId,
  });
  if (providerId === execution.providerId) return execution;
  return resolveProjectExecutionDefaultsForCreate(deps, {
    model: execution.requestedModel,
    projectId: args.projectId,
    providerId,
  });
}
