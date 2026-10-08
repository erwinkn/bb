import type { ReactNode } from "react";
import {
  normalizeThreadGroup,
  ThreadGroupTabStrip,
} from "@/components/thread/ThreadGroupTabStrip";
import {
  type PluginThreadGroupTabsSlot,
  usePluginSlots,
} from "@/lib/plugin-slots";
import { PluginSlotMount } from "./PluginSlotMount";

interface ThreadGroupTarget {
  fallback: ReactNode;
  projectId: string;
  threadId: string;
}

export function PluginThreadGroupTabs(target: ThreadGroupTarget) {
  const { threadGroupTabs } = usePluginSlots();
  return <ThreadGroupSlotChain {...target} slots={threadGroupTabs} />;
}

function ThreadGroupSlotChain({
  slots,
  ...target
}: ThreadGroupTarget & { slots: readonly PluginThreadGroupTabsSlot[] }) {
  const [slot, ...rest] = slots;
  if (slot === undefined) return target.fallback;
  const next = <ThreadGroupSlotChain {...target} slots={rest} />;
  return (
    <PluginSlotMount
      key={`${slot.pluginId}/${slot.id}/${slot.generation}/${target.threadId}`}
      pluginId={slot.pluginId}
      slotKind="threadGroupTabs"
      slotId={slot.id}
      instanceId={target.threadId}
      crashFallback={next}
    >
      <ThreadGroupSlot slot={slot} {...target} fallback={next} />
    </PluginSlotMount>
  );
}

function ThreadGroupSlot({
  slot,
  fallback,
  projectId,
  threadId,
}: ThreadGroupTarget & { slot: PluginThreadGroupTabsSlot }) {
  const group = normalizeThreadGroup(
    slot.useThreadGroup({ threadId, projectId }),
  );
  if (group === null) return fallback;
  return (
    <ThreadGroupTabStrip
      ariaLabel={slot.title}
      group={group}
      threadId={threadId}
    />
  );
}
