import {
  useCallback,
  useRef,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import { cn } from "@bb/shared-ui/lib/utils";

export type DioramaVariant = "paper" | "glossy";

const DIORAMA_CSS = `
.tips-dio {
  --dio-shadow: color-mix(in oklab, var(--ink) 24%, transparent);
  --dio-shadow-soft: color-mix(in oklab, var(--ink) 12%, transparent);
  --dio-hl: color-mix(in oklab, var(--canvas) 92%, transparent);
  --dio-paper: color-mix(in oklab, var(--attention) 5%, var(--canvas));
  --dio-paper-edge: color-mix(in oklab, var(--attention) 10%, color-mix(in oklch, var(--ink) 10%, var(--canvas)));
  --dio-kraft: color-mix(in oklab, var(--attention) 18%, color-mix(in oklch, var(--ink) 4%, var(--canvas)));
  --dio-kraft-deep: color-mix(in oklab, var(--attention) 26%, color-mix(in oklch, var(--ink) 12%, var(--canvas)));
  --dio-stage-top: color-mix(in oklch, var(--ink) 3%, var(--canvas));
  --dio-stage-floor: color-mix(in oklch, var(--ink) 13%, var(--canvas));
  --dio-object: color-mix(in oklch, var(--ink) 5%, var(--canvas));
  --dio-object-deep: color-mix(in oklch, var(--ink) 17%, var(--canvas));
  --dio-body: color-mix(in oklch, var(--ink) 80%, var(--canvas));
  --dio-line: color-mix(in oklch, var(--ink) 22%, var(--canvas));
}
.dark .tips-dio {
  --dio-shadow: color-mix(in oklab, var(--canvas) 88%, transparent);
  --dio-shadow-soft: color-mix(in oklab, var(--canvas) 60%, transparent);
  --dio-hl: color-mix(in oklab, var(--ink) 28%, transparent);
  --dio-paper: color-mix(in oklab, var(--attention) 6%, color-mix(in oklch, var(--ink) 26%, var(--canvas)));
  --dio-paper-edge: color-mix(in oklch, var(--ink) 18%, var(--canvas));
  --dio-kraft: color-mix(in oklab, var(--attention) 10%, color-mix(in oklch, var(--ink) 8%, var(--canvas)));
  --dio-kraft-deep: color-mix(in oklab, var(--attention) 8%, color-mix(in oklch, var(--ink) 4%, var(--canvas)));
  --dio-stage-top: color-mix(in oklch, var(--ink) 14%, var(--canvas));
  --dio-stage-floor: color-mix(in oklch, var(--ink) 4%, var(--canvas));
  --dio-object: color-mix(in oklch, var(--ink) 30%, var(--canvas));
  --dio-object-deep: color-mix(in oklch, var(--ink) 16%, var(--canvas));
  --dio-body: color-mix(in oklch, var(--ink) 10%, var(--canvas));
  --dio-line: color-mix(in oklch, var(--ink) 52%, var(--canvas));
}
.tips-dio [data-depth="1.5"] { --depth: 1.5; }
.tips-dio [data-depth="2"] { --depth: 2; }
.tips-dio [data-depth="3"] { --depth: 3; }
.tips-dio [data-depth="5"] { --depth: 5; }
.tips-dio [data-depth="6"] { --depth: 6; }
.tips-dio [data-depth="7"] { --depth: 7; }
.tips-dio [data-fan="0"] { --fan-rest: -14deg; --fan-open: -24deg; }
.tips-dio [data-fan="1"] { --fan-rest: 0deg; --fan-open: 0deg; }
.tips-dio [data-fan="2"] { --fan-rest: 14deg; --fan-open: 24deg; }
.tips-dio [data-fan] { transform: rotate(var(--fan-rest)); transform-origin: 50% 120%; }
@media (prefers-reduced-motion: no-preference) {
  .tips-dio [data-depth] {
    transform: translate(calc(var(--dx, 0) * var(--depth) * 1px), calc(var(--dy, 0) * var(--depth) * 1px));
    transition: transform 500ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .tips-dio [data-anim="breathe"] { animation: dio-breathe 5s ease-in-out infinite; }
  .tips-dio [data-anim="bob"] { animation: dio-bob 6s ease-in-out infinite; }
  .tips-dio [data-anim="sway"] { animation: dio-sway 7s ease-in-out infinite; transform-origin: 50% 100%; }
  .tips-dio [data-anim="notify"] { animation: dio-notify 8s ease-in-out infinite; }
  .tips-dio [data-anim="letter"] { animation: dio-letter 9s ease-in-out infinite; }
  .tips-dio [data-anim="pane"] { animation: dio-pane 6s ease-in-out infinite; }
  .tips-dio [data-anim="knob"] { animation: dio-knob 11s ease-in-out infinite; }
  .tips-dio [data-anim="cursor"] { animation: dio-cursor 7s ease-in-out infinite; }
  .tips-dio [data-anim="ripple"] { animation: dio-ripple 7s ease-out infinite; }
  .tips-dio [data-fan] { transition: transform 600ms cubic-bezier(0.2, 0.8, 0.2, 1); }
  .group:hover .tips-dio [data-fan], .group:focus-visible .tips-dio [data-fan] {
    transform: rotate(var(--fan-open)) translateY(-3px);
  }
}
@keyframes dio-breathe { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
@keyframes dio-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2px); } }
@keyframes dio-sway { 0%, 100% { transform: rotate(-1.2deg); } 50% { transform: rotate(1.2deg); } }
@keyframes dio-notify {
  0%, 12% { transform: translateY(-16px); opacity: 0; }
  22%, 82% { transform: translateY(0); opacity: 1; }
  92%, 100% { transform: translateY(-16px); opacity: 0; }
}
@keyframes dio-letter {
  0%, 10% { transform: translateY(18px); }
  35%, 80% { transform: translateY(0); }
  95%, 100% { transform: translateY(18px); }
}
@keyframes dio-pane { 0%, 100% { opacity: 0.35; } 25%, 70% { opacity: 1; } }
@keyframes dio-knob { 0%, 100% { transform: rotate(40deg); } 50% { transform: rotate(-20deg); } }
@keyframes dio-cursor {
  0%, 15% { transform: translate(46px, 18px); }
  40%, 70% { transform: translate(0, 0); }
  95%, 100% { transform: translate(46px, 18px); }
}
@keyframes dio-ripple {
  0%, 40% { transform: scale(0.2); opacity: 0; }
  46% { opacity: 0.8; }
  62%, 100% { transform: scale(1.8); opacity: 0; }
}
`;

export function DioramaStyles() {
  return <style>{DIORAMA_CSS}</style>;
}

const SHEET: Record<DioramaVariant, CSSProperties> = {
  paper: {
    background: "var(--dio-paper)",
    borderRadius: 2,
    boxShadow:
      "0 0 0 0.5px var(--dio-paper-edge), 1px 2px 0 var(--dio-shadow-soft), 2px 4px 3px -1px var(--dio-shadow-soft)",
  },
  glossy: {
    background:
      "linear-gradient(180deg, var(--dio-hl) 0%, transparent 45%), linear-gradient(180deg, var(--dio-object), var(--dio-object-deep))",
    borderRadius: 7,
    boxShadow:
      "inset 0 1px 0 var(--dio-hl), inset 0 -2px 3px var(--dio-shadow-soft), 0 8px 12px -6px var(--dio-shadow), 0 1px 2px var(--dio-shadow-soft)",
  },
};

function accent(variant: DioramaVariant, token: string): string {
  return variant === "paper"
    ? `color-mix(in oklab, var(${token}) 62%, var(--dio-paper))`
    : `linear-gradient(180deg, color-mix(in oklab, var(${token}) 55%, var(--canvas)), var(${token}))`;
}

function Bar({ width, tone }: { width: number | string; tone?: string }) {
  return (
    <span
      aria-hidden
      className="block h-[3px] rounded-full"
      style={{ width, background: tone ?? "var(--dio-line)" }}
    />
  );
}

function Dot({
  variant,
  token,
  size = 6,
}: {
  variant: DioramaVariant;
  token: string;
  size?: number;
}) {
  return (
    <span
      aria-hidden
      className="block shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        background: accent(variant, token),
        boxShadow:
          variant === "glossy"
            ? "inset 0 1px 0 var(--dio-hl), 0 0 6px color-mix(in oklab, var(" +
              token +
              ") 45%, transparent)"
            : "0.5px 1px 0 var(--dio-shadow-soft)",
      }}
    />
  );
}

function Stage({
  variant,
  children,
}: {
  variant: DioramaVariant;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const move = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const element = ref.current;
    if (element === null) return;
    const rect = element.getBoundingClientRect();
    const dx = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
    const dy = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
    element.style.setProperty("--dx", dx.toFixed(3));
    element.style.setProperty("--dy", dy.toFixed(3));
  }, []);
  const leave = useCallback(() => {
    ref.current?.style.setProperty("--dx", "0");
    ref.current?.style.setProperty("--dy", "0");
  }, []);
  const background =
    variant === "paper"
      ? "repeating-linear-gradient(115deg, transparent 0 3px, color-mix(in oklab, var(--ink) 2.5%, transparent) 3px 4px), linear-gradient(180deg, var(--dio-kraft), var(--dio-kraft-deep))"
      : "radial-gradient(120% 95% at 50% -15%, var(--dio-stage-top), var(--dio-stage-floor))";
  return (
    <div
      ref={ref}
      aria-hidden
      className="tips-dio relative h-28 w-full overflow-hidden border-b border-border-hairline"
      style={{ background }}
      onPointerMove={move}
      onPointerLeave={leave}
    >
      {variant === "paper" ? <PaperBackdrop /> : <GlossyBackdrop />}
      <div className="absolute left-1/2 top-0 h-28 w-[220px] -translate-x-1/2">
        {children}
      </div>
    </div>
  );
}

function PaperBackdrop() {
  return (
    <>
      <svg
        data-depth="1.5"
        className="absolute inset-x-[-8px] bottom-0 h-16 w-[calc(100%+16px)]"
        viewBox="0 0 240 64"
        preserveAspectRatio="none"
      >
        <path
          d="M0 40 C 30 22, 60 30, 90 26 S 150 14, 180 24 S 225 30, 240 22 L240 64 L0 64 Z"
          fill="color-mix(in oklab, var(--success) 18%, var(--dio-kraft))"
          style={{ filter: "drop-shadow(0 -1px 0 var(--dio-shadow-soft))" }}
        />
      </svg>
      <svg
        data-depth="3"
        className="absolute inset-x-[-12px] bottom-0 h-10 w-[calc(100%+24px)]"
        viewBox="0 0 240 40"
        preserveAspectRatio="none"
      >
        <path
          d="M0 26 C 40 14, 80 30, 120 20 S 200 10, 240 24 L240 40 L0 40 Z"
          fill="color-mix(in oklab, var(--timeline-accent) 14%, var(--dio-paper))"
          style={{ filter: "drop-shadow(0 -1.5px 0 var(--dio-shadow-soft))" }}
        />
      </svg>
    </>
  );
}

function GlossyBackdrop() {
  return (
    <>
      <span
        data-anim="breathe"
        className="absolute inset-x-0 top-0 h-full"
        style={{
          background:
            "radial-gradient(60% 70% at 50% 0%, var(--dio-hl), transparent 70%)",
        }}
      />
      <span
        className="absolute inset-x-6 bottom-2 h-5 rounded-[50%]"
        style={{
          background:
            "radial-gradient(closest-side, var(--dio-shadow-soft), transparent)",
        }}
      />
    </>
  );
}

function Fan({ variant }: { variant: DioramaVariant }) {
  const cards = [
    { token: "--success", x: 52 },
    { token: "--attention", x: 86 },
    { token: "--timeline-accent", x: 120 },
  ];
  return (
    <>
      <svg
        data-depth="2"
        className="absolute inset-0 h-28 w-[220px]"
        viewBox="0 0 220 112"
      >
        {[66, 110, 154].map((x) => (
          <path
            key={x}
            d={`M110 86 C 110 70, ${x} 74, ${x} 56`}
            fill="none"
            stroke="var(--dio-line)"
            strokeWidth={1.2}
            strokeDasharray={variant === "paper" ? "2 2" : undefined}
          />
        ))}
      </svg>
      <div data-depth="5" className="absolute inset-0">
        {cards.map((card, index) => (
          <div
            key={card.token}
            className="absolute top-[14px]"
            style={{ left: card.x - 4 }}
          >
            <div data-anim="sway" style={{ animationDelay: `${index * -2}s` }}>
              <div
                data-fan={index}
                className="flex h-[46px] w-[36px] flex-col gap-1 p-1.5"
                style={SHEET[variant]}
              >
                <Dot variant={variant} token={card.token} size={5} />
                <Bar width="90%" />
                <Bar width="70%" />
                <Bar width="80%" />
              </div>
            </div>
          </div>
        ))}
      </div>
      <div data-depth="7" className="absolute inset-0">
        <div
          className="absolute left-[76px] top-[82px] flex h-[22px] w-[68px] items-center gap-1.5 px-2"
          style={SHEET[variant]}
        >
          <Dot variant={variant} token="--ink" size={5} />
          <Bar width="70%" />
        </div>
      </div>
    </>
  );
}

function Toggle({ variant, on }: { variant: DioramaVariant; on: boolean }) {
  return (
    <span
      className="relative block h-[11px] w-[20px] rounded-full"
      style={{
        background: on ? accent(variant, "--success") : "var(--dio-line)",
        boxShadow:
          variant === "glossy"
            ? "inset 0 1px 2px var(--dio-shadow)"
            : "inset 0.5px 1px 0 var(--dio-shadow-soft)",
      }}
    >
      <span
        className="absolute top-[1.5px] size-[8px] rounded-full"
        style={{
          left: on ? 10 : 2,
          background:
            variant === "glossy"
              ? "radial-gradient(circle at 35% 30%, var(--dio-hl), var(--dio-object) 60%, var(--dio-object-deep))"
              : "var(--dio-paper)",
          boxShadow: "0 1px 1.5px var(--dio-shadow)",
        }}
      />
    </span>
  );
}

function ControlPanel({ variant }: { variant: DioramaVariant }) {
  return (
    <div data-depth="5" className="absolute inset-0">
      <div
        className="absolute left-[34px] top-[22px] flex h-[68px] w-[152px] items-center gap-3 px-3"
        style={{
          ...SHEET[variant],
          transform: variant === "paper" ? "rotate(-1.5deg)" : undefined,
        }}
      >
        <div className="flex flex-col gap-2">
          {[true, true, false].map((on, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <Toggle variant={variant} on={on} />
              <Bar width={26} />
            </div>
          ))}
        </div>
        <div className="ml-auto flex flex-col items-center gap-1.5">
          <span
            className="relative block size-[34px] rounded-full"
            style={{
              background:
                variant === "glossy"
                  ? "radial-gradient(circle at 35% 30%, var(--dio-hl), var(--dio-object) 55%, var(--dio-object-deep))"
                  : "var(--dio-paper)",
              boxShadow:
                variant === "glossy"
                  ? "0 4px 6px -2px var(--dio-shadow), inset 0 -2px 3px var(--dio-shadow-soft)"
                  : "0 0 0 0.5px var(--dio-paper-edge), 1px 2px 0 var(--dio-shadow-soft)",
            }}
          >
            <span data-anim="knob" className="absolute inset-0 block">
              <span
                className="absolute left-1/2 top-[4px] h-[9px] w-[2px] -translate-x-1/2 rounded-full"
                style={{ background: "var(--dio-body)" }}
              />
            </span>
          </span>
          <span data-anim="breathe">
            <Dot variant={variant} token="--success" size={5} />
          </span>
        </div>
      </div>
    </div>
  );
}

function PhoneOnStand({ variant }: { variant: DioramaVariant }) {
  const glossy = variant === "glossy";
  return (
    <>
      <div data-depth="3" className="absolute inset-0">
        <span
          className="absolute left-[92px] top-[92px] block h-[8px] w-[36px] rounded-sm"
          style={SHEET[variant]}
        />
      </div>
      <div data-depth="6" className="absolute inset-0">
        <div data-anim="bob" className="absolute left-[86px] top-[8px]">
          <div
            className="relative h-[86px] w-[48px] overflow-hidden p-[3px]"
            style={{
              borderRadius: glossy ? 10 : 6,
              background: glossy
                ? "linear-gradient(160deg, var(--dio-body), color-mix(in oklch, var(--dio-body) 70%, var(--ink)))"
                : "var(--dio-paper)",
              boxShadow: glossy
                ? "inset 0 1px 0 var(--dio-hl), 0 10px 14px -6px var(--dio-shadow)"
                : "0 0 0 0.5px var(--dio-paper-edge), 2px 3px 0 var(--dio-shadow-soft)",
              transform: glossy ? "rotate(-4deg)" : "rotate(-3deg)",
            }}
          >
            <div
              className="flex h-full flex-col gap-1.5 px-1.5 pt-4"
              style={{
                borderRadius: glossy ? 7 : 4,
                background: glossy
                  ? "linear-gradient(180deg, var(--dio-object), var(--dio-stage-top))"
                  : "color-mix(in oklab, var(--timeline-accent) 10%, var(--dio-paper))",
              }}
            >
              {[0, 1, 2].map((row) => (
                <div key={row} className="flex items-center gap-1">
                  <Dot
                    variant={variant}
                    token={row === 1 ? "--attention" : "--timeline-accent"}
                    size={4}
                  />
                  <Bar width={22} />
                </div>
              ))}
            </div>
            <div
              data-anim="notify"
              className="absolute inset-x-[5px] top-[6px] flex items-center gap-1 px-1 py-[3px]"
              style={{
                ...SHEET[variant],
                borderRadius: glossy ? 5 : 2,
              }}
            >
              <Dot variant={variant} token="--attention" size={4} />
              <Bar width={20} />
            </div>
            {glossy ? (
              <span
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    "linear-gradient(115deg, transparent 40%, var(--dio-hl) 48%, transparent 58%)",
                  opacity: 0.5,
                }}
              />
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}

function Monitor({ variant }: { variant: DioramaVariant }) {
  const panes = ["--attention", "--destructive", "--success"];
  return (
    <>
      <div data-depth="3" className="absolute inset-0">
        <span
          className="absolute left-[100px] top-[86px] block h-[10px] w-[20px]"
          style={{ ...SHEET[variant], borderRadius: 1 }}
        />
        <span
          className="absolute left-[82px] top-[95px] block h-[5px] w-[56px] rounded-sm"
          style={SHEET[variant]}
        />
      </div>
      <div data-depth="6" className="absolute inset-0">
        <div
          className="absolute left-[38px] top-[10px] flex h-[78px] w-[144px] gap-1 p-[5px]"
          style={{
            ...SHEET[variant],
            background:
              variant === "glossy"
                ? "linear-gradient(180deg, var(--dio-hl) 0%, transparent 30%), var(--dio-body)"
                : "var(--dio-paper)",
          }}
        >
          {panes.map((token, index) => (
            <div
              key={token}
              data-anim="pane"
              className="flex flex-1 flex-col gap-1 p-1"
              style={{
                animationDelay: `${index * 0.8}s`,
                borderRadius: variant === "glossy" ? 3 : 1,
                background:
                  variant === "glossy"
                    ? "linear-gradient(180deg, var(--dio-object), var(--dio-object-deep))"
                    : "color-mix(in oklch, var(--ink) 4%, var(--dio-paper))",
                boxShadow:
                  variant === "glossy"
                    ? `0 0 8px color-mix(in oklab, var(${token}) 35%, transparent)`
                    : "inset 0 0 0 0.5px var(--dio-paper-edge)",
              }}
            >
              <Dot variant={variant} token={token} size={4} />
              <Bar width="85%" />
              <Bar width="60%" />
              <Bar width="75%" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function MailSlot({ variant }: { variant: DioramaVariant }) {
  return (
    <>
      <div data-depth="2" className="absolute inset-0">
        <span data-anim="breathe" className="absolute left-[18px] top-[12px]">
          <span
            className="block size-[18px] rounded-full"
            style={{
              background: accent(variant, "--warning"),
              boxShadow:
                variant === "glossy"
                  ? "0 0 14px color-mix(in oklab, var(--warning) 50%, transparent)"
                  : "1px 1.5px 0 var(--dio-shadow-soft)",
            }}
          />
        </span>
      </div>
      <div data-depth="5" className="absolute inset-0">
        <div className="absolute left-[60px] top-[14px] h-[60px] w-[100px] overflow-hidden">
          <div
            data-anim="letter"
            className="absolute left-[10px] top-[8px] h-[54px] w-[80px]"
            style={SHEET[variant]}
          >
            <svg
              className="absolute inset-x-0 top-0 h-[26px] w-full"
              viewBox="0 0 80 26"
            >
              <path
                d="M1 1 L40 22 L79 1"
                fill="none"
                stroke="var(--dio-line)"
                strokeWidth={1.2}
              />
            </svg>
            <span
              className="absolute bottom-[8px] left-1/2 block size-[10px] -translate-x-1/2 rounded-full"
              style={{
                background: accent(variant, "--destructive"),
                boxShadow: "0 1px 1px var(--dio-shadow-soft)",
              }}
            />
          </div>
        </div>
      </div>
      <div data-depth="7" className="absolute inset-0">
        <div
          className="absolute left-[46px] top-[72px] flex h-[26px] w-[128px] items-center justify-center"
          style={{
            ...SHEET[variant],
            background:
              variant === "glossy"
                ? "linear-gradient(180deg, var(--dio-hl), transparent 50%), linear-gradient(180deg, color-mix(in oklab, var(--warning) 30%, var(--dio-object)), color-mix(in oklab, var(--warning) 45%, var(--dio-object-deep)))"
                : "color-mix(in oklab, var(--warning) 24%, var(--dio-paper))",
          }}
        >
          <span
            className="block h-[5px] w-[88px] rounded-full"
            style={{
              background: "var(--dio-body)",
              boxShadow: "inset 0 1px 2px var(--dio-shadow)",
            }}
          />
        </div>
      </div>
    </>
  );
}

function BrowserWindow({ variant }: { variant: DioramaVariant }) {
  return (
    <div data-depth="5" className="absolute inset-0">
      <div
        className="absolute left-[30px] top-[16px] h-[80px] w-[160px] overflow-hidden"
        style={SHEET[variant]}
      >
        <div
          className="flex items-center gap-1 px-2 py-1.5"
          style={{ borderBottom: "1px solid var(--dio-line)" }}
        >
          <Dot variant={variant} token="--destructive" size={4} />
          <Dot variant={variant} token="--warning" size={4} />
          <Dot variant={variant} token="--success" size={4} />
          <span className="ml-1">
            <Bar width={56} />
          </span>
        </div>
        <div className="flex flex-col gap-1.5 p-2">
          <Bar width="45%" tone="var(--dio-body)" />
          <Bar width="80%" />
          <Bar width="65%" />
          <span
            className="mt-0.5 block h-[11px] w-[40px] rounded-sm"
            style={{ background: accent(variant, "--timeline-accent") }}
          />
        </div>
        <span
          className="absolute right-[8px] top-[26px] rounded-sm px-1 text-2xs leading-3"
          style={{
            background: accent(variant, "--destructive"),
            color: "var(--canvas)",
          }}
        >
          1 issue
        </span>
        <div className="absolute left-[18px] top-[56px]">
          <span
            data-anim="ripple"
            className="absolute left-[-6px] top-[-6px] block size-[14px] rounded-full"
            style={{
              border:
                "1.5px solid color-mix(in oklab, var(--timeline-accent) 70%, transparent)",
            }}
          />
          <svg
            data-anim="cursor"
            viewBox="0 0 12 12"
            className="absolute size-3"
            style={{
              filter: "drop-shadow(0 1px 1px var(--dio-shadow))",
            }}
          >
            <path
              d="M1 1 L1 10 L3.6 7.6 L5.6 11 L7 10.3 L5.1 7 L8.6 7 Z"
              fill="var(--dio-body)"
              stroke="var(--dio-paper)"
              strokeWidth={0.8}
            />
          </svg>
        </div>
      </div>
    </div>
  );
}

const SCENES: Record<
  string,
  (props: { variant: DioramaVariant }) => ReactNode
> = {
  subthreads: Fan,
  "set-up-for-me": ControlPanel,
  phone: PhoneOnStand,
  "open-threads-that-need-me": Monitor,
  "morning-digest": MailSlot,
  "browser-automation": BrowserWindow,
};

export function TipDiorama({
  tipId,
  variant,
  className,
}: {
  tipId: string;
  variant: DioramaVariant;
  className?: string;
}) {
  const Scene = SCENES[tipId] ?? BrowserWindow;
  return (
    <div className={cn("w-full", className)}>
      <Stage variant={variant}>
        <Scene variant={variant} />
      </Stage>
    </div>
  );
}
