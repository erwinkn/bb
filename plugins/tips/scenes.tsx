import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const MOTION = "motion-safe:transition-all motion-safe:duration-300";
const SCENE_WIDTH = 200;
const SCENE_HEIGHT = 112;

interface SceneProps {
  active: boolean;
  task: string | null;
}

function Bar({
  className,
  width,
}: {
  className?: string;
  width: number | string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "block h-1 shrink-0 rounded-full bg-muted-foreground/25",
        className,
      )}
      style={{ width }}
    />
  );
}

function Dot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("block size-1.5 shrink-0 rounded-full", className)}
    />
  );
}

function MiniText({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "block min-w-0 truncate text-2xs leading-none text-foreground/80",
        className,
      )}
    >
      {children}
    </span>
  );
}

function MiniWindow({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-border bg-background shadow-xs",
        className,
      )}
      style={style}
    >
      {children}
    </div>
  );
}

function delay(active: boolean, ms: number): CSSProperties {
  return { transitionDelay: active ? `${ms}ms` : "0ms" };
}

function SubthreadsScene({ active, task }: SceneProps) {
  const children = [
    { label: "Approach A · retry", done: "bg-success" },
    { label: "Approach B · mock clock", done: "bg-attention" },
    { label: "Approach C · rewrite", done: "bg-timeline-accent" },
  ];
  return (
    <div className="flex h-full flex-col justify-center gap-2 px-4">
      <div className="flex items-center gap-1.5">
        <Dot className="bg-foreground/70" />
        <MiniText className="font-medium">
          {task ?? "Fix the flaky login test"}
        </MiniText>
      </div>
      <div className="ml-[2px] flex flex-col gap-1.5 border-l border-border pl-3">
        {children.map((child, index) => (
          <div
            key={child.label}
            className={cn(
              "flex items-center gap-1.5",
              MOTION,
              active
                ? "translate-x-0 opacity-100"
                : "-translate-x-1 opacity-70",
            )}
            style={delay(active, index * 90)}
          >
            <Dot
              className={cn(
                MOTION,
                active ? child.done : "bg-muted-foreground/40",
              )}
            />
            <MiniText className="text-muted-foreground">{child.label}</MiniText>
          </div>
        ))}
      </div>
    </div>
  );
}

function SplitPanesScene({ active }: SceneProps) {
  const panes = [
    { title: "Input", tone: "bg-attention", rest: "-rotate-6" },
    { title: "Error", tone: "bg-destructive", rest: "rotate-0" },
    { title: "Done", tone: "bg-success", rest: "rotate-6" },
  ];
  return (
    <div className="relative h-full">
      {panes.map((pane, index) => (
        <MiniWindow
          key={pane.title}
          className={cn(
            "absolute top-[18px] h-[76px] w-[60px]",
            MOTION,
            active ? "rotate-0" : pane.rest,
          )}
          style={{
            left: active ? 3 + index * 66 : 64 + (index - 1) * 12,
            zIndex: active ? 1 : index === 1 ? 3 : 2,
          }}
        >
          <div className="flex items-center gap-1 border-b border-border px-1.5 py-1">
            <Dot
              className={cn(
                MOTION,
                active ? pane.tone : "bg-muted-foreground/40",
              )}
            />
            <MiniText className="text-muted-foreground">{pane.title}</MiniText>
          </div>
          <div className="flex flex-col gap-1 p-1.5">
            <Bar width="80%" />
            <Bar width="60%" />
            <Bar width="70%" />
          </div>
        </MiniWindow>
      ))}
    </div>
  );
}

function DigestScene({ active }: SceneProps) {
  const rows = [
    { tone: "bg-attention", width: "72%" },
    { tone: "bg-warning", width: "58%" },
    { tone: "bg-success", width: "64%" },
  ];
  return (
    <div className="relative flex h-full items-end justify-center overflow-hidden">
      <MiniWindow
        className={cn(
          "w-[150px] rounded-b-none border-b-0 px-2.5 pb-3 pt-2",
          MOTION,
          active ? "translate-y-0" : "translate-y-4",
        )}
      >
        <div className="flex items-center gap-1.5">
          <span className="flex size-3.5 items-center justify-center rounded-full bg-foreground text-2xs leading-none text-background">
            b
          </span>
          <MiniText className="font-medium">Morning digest</MiniText>
          <span className="ml-auto text-2xs leading-none text-muted-foreground">
            8:00
          </span>
        </div>
        <div className="mt-2 flex flex-col gap-1.5">
          {rows.map((row, index) => (
            <div
              key={row.tone}
              className={cn(
                "flex items-center gap-1.5",
                MOTION,
                active ? "opacity-100" : "opacity-50",
              )}
              style={delay(active, 120 + index * 80)}
            >
              <Dot className={row.tone} />
              <Bar width={row.width} />
            </div>
          ))}
        </div>
      </MiniWindow>
    </div>
  );
}

function DecisionScene({ active }: SceneProps) {
  return (
    <div className="flex h-full flex-col justify-center gap-2 px-4">
      <div className="flex w-[78%] flex-col gap-1 rounded-md bg-muted px-2 py-1.5">
        <MiniText className="text-muted-foreground">
          Tests pass. Merge now?
        </MiniText>
      </div>
      <div className="flex gap-1">
        {["Merge", "Hold", "Revise"].map((label, index) => (
          <span
            key={label}
            className={cn(
              "rounded-full border px-2 py-0.5 text-2xs leading-none",
              MOTION,
              index === 0 && active
                ? "scale-95 border-foreground bg-foreground text-background"
                : "border-border text-foreground/80",
            )}
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

function PhoneScene({ active }: SceneProps) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="relative h-[92px] w-[52px] overflow-hidden rounded-[10px] border-2 border-foreground/60 bg-background">
        <span className="absolute left-1/2 top-1 h-1 w-3 -translate-x-1/2 rounded-full bg-foreground/60" />
        <div className="mt-4 flex flex-col gap-1.5 px-1.5">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="flex items-center gap-1">
              <Dot
                className={
                  row === 1 ? "bg-attention" : "bg-muted-foreground/40"
                }
              />
              <Bar width={row === 1 ? 24 : 20} />
            </div>
          ))}
        </div>
        <div
          className={cn(
            "absolute inset-x-1 top-1 rounded-sm border border-border bg-popover px-1 py-0.5 shadow-sm",
            MOTION,
            active ? "translate-y-0 opacity-100" : "-translate-y-6 opacity-0",
          )}
        >
          <div className="flex items-center gap-0.5">
            <Dot className="size-1 bg-attention" />
            <Bar width={22} className="bg-foreground/40" />
          </div>
        </div>
      </div>
    </div>
  );
}

function BrowserScene({ active }: SceneProps) {
  return (
    <div className="flex h-full items-center justify-center">
      <MiniWindow className="relative h-[84px] w-[164px]">
        <div className="flex items-center gap-1 border-b border-border px-1.5 py-1">
          <Dot className="size-1 bg-muted-foreground/40" />
          <Dot className="size-1 bg-muted-foreground/40" />
          <span className="ml-1 rounded-sm bg-muted px-1.5 text-2xs leading-3 text-muted-foreground">
            localhost:3000
          </span>
        </div>
        <div className="flex flex-col gap-1.5 p-2">
          <Bar width="45%" className="bg-foreground/35" />
          <Bar width="80%" />
          <Bar width="65%" />
          <span className="mt-0.5 h-3 w-10 rounded-sm bg-foreground/80" />
        </div>
        <span
          className={cn(
            "absolute right-2 top-6 rounded-sm bg-surface-destructive px-1 text-2xs leading-3 text-destructive-text",
            MOTION,
            active ? "scale-100 opacity-100" : "scale-90 opacity-0",
          )}
          style={delay(active, 260)}
        >
          1 issue
        </span>
        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className={cn(
            "absolute size-3 fill-foreground stroke-background",
            MOTION,
          )}
          style={{ left: active ? 24 : 120, top: active ? 62 : 70 }}
        >
          <path
            d="M1 1 L1 10 L3.6 7.6 L5.6 11 L7 10.3 L5.1 7 L8.6 7 Z"
            strokeWidth={0.8}
          />
        </svg>
      </MiniWindow>
    </div>
  );
}

function BuildToolScene({ active }: SceneProps) {
  const bars = [38, 62, 46, 80];
  return (
    <div className="flex h-full items-center justify-center">
      <MiniWindow className="relative flex h-[84px] w-[164px]">
        <div className="flex w-9 flex-col gap-1.5 border-r border-border p-1.5">
          <Bar width="90%" />
          <Bar width="70%" />
          <Bar width="80%" />
        </div>
        <div className="flex flex-1 flex-col gap-1.5 p-2">
          <Bar width="70%" />
          <Bar width="50%" />
        </div>
        <div
          className={cn(
            "absolute inset-y-0 right-0 flex w-[72px] flex-col border-l border-border bg-background p-1.5",
            MOTION,
            active ? "translate-x-0" : "translate-x-[52px]",
          )}
        >
          <MiniText className="font-medium">Your tool</MiniText>
          <div className="mt-auto flex h-10 items-end gap-1">
            {bars.map((height, index) => (
              <span
                key={height}
                className={cn("w-2 rounded-t-sm bg-timeline-accent", MOTION)}
                style={{
                  height: active ? `${height}%` : "12%",
                  ...delay(active, 200 + index * 70),
                }}
              />
            ))}
          </div>
        </div>
      </MiniWindow>
    </div>
  );
}

function UsageBarsScene({
  active,
  rows,
  marker,
}: SceneProps & {
  rows: readonly { name: string; usage: number; tone: string }[];
  marker: boolean;
}) {
  return (
    <div
      className={cn(
        "relative flex h-full flex-col justify-center gap-2 pl-4",
        marker ? "pr-16" : "pr-4",
      )}
    >
      {rows.map((row, index) => (
        <div key={row.name} className="flex items-center gap-2">
          <MiniText className="w-11 text-muted-foreground">{row.name}</MiniText>
          <span className="relative h-1 flex-1 overflow-hidden rounded-full bg-muted-foreground/20">
            <span
              className={cn(
                "absolute inset-y-0 left-0 rounded-full",
                MOTION,
                row.tone,
              )}
              style={{
                width: active || marker ? `${row.usage}%` : "8%",
                ...delay(active, index * 90),
              }}
            />
          </span>
        </div>
      ))}
      {marker ? (
        <span
          className={cn(
            "absolute right-3 flex items-center gap-1 rounded-sm border border-border bg-popover px-1 py-0.5 shadow-xs",
            MOTION,
          )}
          style={{ top: active ? "calc(50% - 6px)" : "calc(50% - 20px)" }}
        >
          <Dot className="size-1 bg-timeline-accent" />
          <Bar width={14} className="bg-foreground/40" />
        </span>
      ) : null}
    </div>
  );
}

function AccountPoolScene(props: SceneProps) {
  return (
    <UsageBarsScene
      {...props}
      marker
      rows={[
        { name: "Work", usage: 100, tone: "bg-warning" },
        { name: "Personal", usage: 35, tone: "bg-success" },
        { name: "Team", usage: 20, tone: "bg-success" },
      ]}
    />
  );
}

function ProviderUsageScene(props: SceneProps) {
  return (
    <UsageBarsScene
      {...props}
      marker={false}
      rows={[
        { name: "Claude", usage: 72, tone: "bg-attention" },
        { name: "Codex", usage: 41, tone: "bg-timeline-accent" },
        { name: "Cursor", usage: 18, tone: "bg-success" },
      ]}
    />
  );
}

function QueueSteerScene({ active }: SceneProps) {
  return (
    <div className="flex h-full flex-col justify-center gap-1.5 px-4">
      <div className="flex items-center gap-1.5">
        <Dot className="bg-timeline-accent motion-safe:animate-pulse" />
        <MiniText className="text-muted-foreground">Agent is working…</MiniText>
      </div>
      <div
        className={cn(
          "ml-3 flex items-center gap-1 rounded-sm border border-dashed border-border px-1.5 py-1",
          MOTION,
          active ? "opacity-100" : "opacity-0",
        )}
      >
        <MiniText className="text-muted-foreground">
          Queued · update docs
        </MiniText>
      </div>
      <div className="flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-1">
        <Bar width="40%" />
        <span
          className={cn(
            "ml-auto rounded-sm px-1 text-2xs leading-3",
            active ? "text-muted-foreground" : "bg-muted text-foreground/80",
          )}
        >
          Steer
        </span>
        <span
          className={cn(
            "rounded-sm px-1 text-2xs leading-3",
            active ? "bg-muted text-foreground/80" : "text-muted-foreground",
          )}
        >
          Queue
        </span>
      </div>
    </div>
  );
}

function PaletteScene({ active, keys }: SceneProps & { keys: string }) {
  const rows = ["New thread", "Open settings", "Toggle right panel"];
  return (
    <div className="flex h-full items-center justify-center">
      <MiniWindow className="w-[150px] bg-popover">
        <div className="flex items-center gap-1 border-b border-border px-1.5 py-1">
          <Bar width={40} />
          <span className="ml-auto rounded-sm border border-border px-1 text-2xs leading-3 text-muted-foreground">
            {keys}
          </span>
        </div>
        <div className="flex flex-col p-1">
          {rows.map((row, index) => (
            <span
              key={row}
              className={cn(
                "rounded-sm px-1 py-0.5",
                MOTION,
                (active ? index === 1 : index === 0) && "bg-state-active",
              )}
            >
              <MiniText className="text-muted-foreground">{row}</MiniText>
            </span>
          ))}
        </div>
      </MiniWindow>
    </div>
  );
}

function ScheduleScene({ active }: SceneProps) {
  return (
    <div className="flex h-full items-center justify-center gap-1.5">
      {["M", "T", "W", "T", "F"].map((day, index) => (
        <div
          key={`${day}-${index}`}
          className="flex h-[60px] w-[22px] flex-col items-center gap-1.5 rounded-md border border-border bg-background pt-1"
        >
          <span className="text-2xs leading-none text-muted-foreground">
            {day}
          </span>
          <span
            aria-hidden
            className={cn(
              "block size-1.5 rounded-full",
              MOTION,
              active ? "bg-timeline-accent" : "bg-muted-foreground/30",
            )}
            style={delay(active, index * 70)}
          />
        </div>
      ))}
    </div>
  );
}

function SettingsScene({ active }: SceneProps) {
  const rows = ["Default provider", "Add a machine", "Notifications"];
  return (
    <div className="flex h-full items-center justify-center">
      <MiniWindow className="flex w-[160px] flex-col gap-1.5 px-2.5 py-2">
        {rows.map((row, index) => (
          <div key={row} className="flex items-center gap-2">
            <MiniText className="flex-1 text-muted-foreground">{row}</MiniText>
            <span
              className={cn(
                "relative h-2.5 w-[18px] shrink-0 rounded-full",
                MOTION,
                active ? "bg-success" : "bg-muted-foreground/30",
              )}
              style={delay(active, index * 110)}
            >
              <span
                className={cn(
                  "absolute top-[1px] size-2 rounded-full bg-background",
                  MOTION,
                  active ? "left-[9px]" : "left-[1px]",
                )}
                style={delay(active, index * 110)}
              />
            </span>
          </div>
        ))}
      </MiniWindow>
    </div>
  );
}

function ChangelogScene({ active }: SceneProps) {
  const rows = [
    { tone: "bg-success", width: "70%" },
    { tone: "bg-timeline-accent", width: "56%" },
    { tone: "bg-attention", width: "62%" },
  ];
  return (
    <div className="flex h-full items-center justify-center">
      <MiniWindow className="w-[150px] px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <span className="rounded-sm bg-foreground px-1 text-2xs leading-3 text-background">
            New
          </span>
          <MiniText className="font-medium">This update</MiniText>
        </div>
        <div className="mt-2 flex flex-col gap-1.5">
          {rows.map((row, index) => (
            <div
              key={row.tone}
              className={cn(
                "flex items-center gap-1.5",
                MOTION,
                active
                  ? "translate-y-0 opacity-100"
                  : "translate-y-1 opacity-40",
              )}
              style={delay(active, index * 90)}
            >
              <Dot className={row.tone} />
              <Bar width={row.width} />
            </div>
          ))}
        </div>
      </MiniWindow>
    </div>
  );
}

export function TipScene({
  tipId,
  active,
  task,
}: {
  tipId: string;
  active: boolean;
  task: string | null;
}) {
  const props = { active, task };
  switch (tipId) {
    case "whats-new":
      return <ChangelogScene {...props} />;
    case "subthreads":
      return <SubthreadsScene {...props} />;
    case "set-up-for-me":
      return <SettingsScene {...props} />;
    case "open-threads-that-need-me":
      return <SplitPanesScene {...props} />;
    case "morning-digest":
      return <DigestScene {...props} />;
    case "decision-buttons":
      return <DecisionScene {...props} />;
    case "phone":
      return <PhoneScene {...props} />;
    case "browser-automation":
      return <BrowserScene {...props} />;
    case "build-plugin":
      return <BuildToolScene {...props} />;
    case "account-pool":
      return <AccountPoolScene {...props} />;
    case "provider-usage":
      return <ProviderUsageScene {...props} />;
    case "queue-or-steer":
      return <QueueSteerScene {...props} />;
    case "command-palette":
      return <PaletteScene {...props} keys="⌘⇧P" />;
    case "thread-search":
      return <PaletteScene {...props} keys="⌘K" />;
    default:
      return <ScheduleScene {...props} />;
  }
}

function useReplay(active: boolean): boolean {
  const [resetting, setResetting] = useState(false);
  useEffect(() => {
    if (!active) return;
    setResetting(true);
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setResetting(false));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      setResetting(false);
    };
  }, [active]);
  return resetting;
}

export function TipGraphic({
  tipId,
  active,
  task,
  className,
}: {
  tipId: string;
  active: boolean;
  task: string | null;
  className?: string;
}) {
  const resetting = useReplay(active);
  return (
    <div
      aria-hidden
      data-tip-scene={tipId}
      className={cn(
        "relative overflow-hidden bg-surface-recessed",
        resetting && "[&_*]:!transition-none",
        className,
      )}
    >
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
        style={{ width: SCENE_WIDTH, height: SCENE_HEIGHT }}
      >
        <TipScene tipId={tipId} active={!resetting} task={task} />
      </div>
    </div>
  );
}
