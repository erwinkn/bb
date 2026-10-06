import type { CSSProperties, ReactNode, SVGProps } from "react";
import type { TipTone } from "./contract.js";

const TONE_COLOR: Record<TipTone, string> = {
  blue: "var(--timeline-accent)",
  green: "var(--success)",
  amber: "var(--attention)",
  orange: "var(--warning)",
  rose: "color-mix(in oklab, var(--destructive) 55%, var(--timeline-accent))",
};

const LINE = {
  stroke: "currentColor",
  strokeWidth: 1.1,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  fill: "none",
} as const;

const WASH = 0.1;
const SOFT = 0.4;

function Panel(props: SVGProps<SVGRectElement>) {
  return (
    <rect {...LINE} fill="currentColor" fillOpacity={WASH} rx={3} {...props} />
  );
}

function Rule({
  x,
  y,
  width,
  soft = false,
}: {
  x: number;
  y: number;
  width: number;
  soft?: boolean;
}) {
  return (
    <line
      {...LINE}
      strokeOpacity={soft ? SOFT : 1}
      x1={x}
      y1={y}
      x2={x + width}
      y2={y}
    />
  );
}

function Dot({
  cx,
  cy,
  r = 1.75,
  fill = "currentColor",
}: {
  cx: number;
  cy: number;
  r?: number;
  fill?: string;
}) {
  return <circle cx={cx} cy={cy} r={r} style={{ fill }} />;
}

const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const ACTIVE = "[data-tip-art-trigger]:is(:hover, :focus-visible) .tip-art";

const TIP_ART_CSS = `
.tip-art [data-tip-motion], .tip-art [data-tip-reveal], .tip-art [data-tip-hide] {
  transform-box: fill-box;
  transform-origin: center;
}
.tip-art [data-tip-reveal], .tip-art [data-tip-hide] {
  transition: transform 0.8s ${EASE}, opacity 0.6s ${EASE};
}
${ACTIVE} [data-tip-reveal] { transform: none !important; opacity: 1 !important; }
${ACTIVE} [data-tip-hide] { opacity: 0; }
${ACTIVE} [data-tip-motion] { animation: 0.9s ${EASE} both; }
${ACTIVE} [data-tip-motion="pop"] { animation-name: tip-art-pop; }
${ACTIVE} [data-tip-motion="twinkle"] { animation-name: tip-art-twinkle; }
${ACTIVE} [data-tip-motion="nudge"] { animation-name: tip-art-nudge; }
${ACTIVE} [data-tip-motion="spin"] { animation-name: tip-art-spin; animation-duration: 1.2s; }
${ACTIVE} [data-tip-motion="slide"] { animation-name: tip-art-slide; }
${ACTIVE} [data-tip-motion="sweep"] { animation-name: tip-art-sweep; animation-duration: 1.1s; }
${ACTIVE} [data-tip-motion="press"] { animation-name: tip-art-press; animation-duration: 0.5s; }
${ACTIVE} [data-tip-motion="fade"] { animation-name: tip-art-fade; animation-duration: 0.6s; }
${ACTIVE} [data-tip-motion="grow"] { animation-name: tip-art-grow; }
${ACTIVE} [data-tip-motion="snap"] { animation-name: tip-art-snap; }
${ACTIVE} [data-tip-motion="travel"] { animation-name: tip-art-travel; }
${ACTIVE} [data-tip-motion="rise"] { animation-name: tip-art-rise; }
${ACTIVE} [data-tip-delay="1"] { animation-delay: 0.12s; transition-delay: 0.12s; }
${ACTIVE} [data-tip-delay="2"] { animation-delay: 0.24s; transition-delay: 0.24s; }
${ACTIVE} [data-tip-delay="3"] { animation-delay: 0.36s; transition-delay: 0.36s; }
${ACTIVE} [data-tip-delay="4"] { animation-delay: 0.48s; transition-delay: 0.48s; }
@media (prefers-reduced-motion: reduce) {
  .tip-art [data-tip-motion], .tip-art [data-tip-reveal], .tip-art [data-tip-hide] {
    animation: none !important;
    transition: none !important;
  }
}
@keyframes tip-art-pop { 0% { transform: scale(0); opacity: 0; } 60% { transform: scale(1.25); opacity: 1; } 100% { transform: none; } }
@keyframes tip-art-twinkle { 0% { transform: none; } 45% { transform: scale(1.45) rotate(30deg); } 100% { transform: none; } }
@keyframes tip-art-nudge { 0%, 100% { transform: none; } 45% { transform: translateX(3px); } }
@keyframes tip-art-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes tip-art-slide { from { transform: translateX(8px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes tip-art-sweep { 0% { transform: translate(-10px, -14px); } 55% { transform: translate(-4px, -4px); } 100% { transform: none; } }
@keyframes tip-art-press { 0%, 100% { transform: none; } 40% { transform: translateY(1.5px) scale(0.92); } }
@keyframes tip-art-fade { from { transform: translateY(2px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes tip-art-grow { from { transform: scaleY(0.2); } to { transform: none; } }
@keyframes tip-art-snap { from { transform: translate(7px, -7px) rotate(-25deg); opacity: 0.3; } to { transform: none; opacity: 1; } }
@keyframes tip-art-travel { from { transform: translate(10px, 8px); } to { transform: none; } }
@keyframes tip-art-rise { from { transform: translateY(6px); } to { transform: none; } }
`;

export function TipArtStyles() {
  return <style>{TIP_ART_CSS}</style>;
}

type Motion =
  | "pop"
  | "twinkle"
  | "nudge"
  | "spin"
  | "slide"
  | "sweep"
  | "press"
  | "fade"
  | "grow"
  | "snap"
  | "travel"
  | "rise";

type Delay = 0 | 1 | 2 | 3 | 4;

function Act({
  motion,
  delay = 0,
  style,
  children,
}: {
  motion: Motion;
  delay?: Delay;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <g data-tip-motion={motion} data-tip-delay={delay} style={style}>
      {children}
    </g>
  );
}

function Reveal({
  rest,
  delay = 0,
  children,
}: {
  rest: CSSProperties;
  delay?: Delay;
  children: ReactNode;
}) {
  return (
    <g data-tip-reveal="" data-tip-delay={delay} style={rest}>
      {children}
    </g>
  );
}

function Hide({ children }: { children: ReactNode }) {
  return <g data-tip-hide="">{children}</g>;
}

const HIDDEN: CSSProperties = { opacity: 0 };

function delayAt(index: number): Delay {
  return index <= 0
    ? 0
    : index >= 4
      ? 4
      : index === 1
        ? 1
        : index === 2
          ? 2
          : 3;
}

type Art = (accent: string) => ReactNode;

const ART: Record<string, Art> = {
  "whats-new": (accent) => (
    <>
      <Panel x={6} y={9} width={28} height={33} />
      <Rule x={11} y={16} width={10} />
      <path {...LINE} d="M11 23.5h2.5M12.25 22.25v2.5" />
      <Rule x={16.5} y={23.5} width={12} soft />
      <path {...LINE} d="M11 30.5h2.5M12.25 29.25v2.5" />
      <Rule x={16.5} y={30.5} width={9} soft />
      <Rule x={11} y={36.5} width={14} soft />
      <Act motion="twinkle">
        <path
          d="M39 6.5c.5 3 1.5 4 4.5 4.5-3 .5-4 1.5-4.5 4.5-.5-3-1.5-4-4.5-4.5 3-.5 4-1.5 4.5-4.5Z"
          style={{ fill: accent }}
        />
      </Act>
    </>
  ),
  "account-pool": (accent) => (
    <>
      <Panel x={12} y={5} width={28} height={16} strokeOpacity={SOFT} />
      <Panel x={6} y={11} width={28} height={16} />
      <circle {...LINE} cx={13} cy={19} r={3} />
      <Rule x={19} y={17} width={10} />
      <Rule x={19} y={21.5} width={7} soft />
      <path {...LINE} d="M20 27v5.5a4 4 0 0 0 4 4h6" />
      <Act motion="nudge">
        <path d="M30 33.5l3.5 3-3.5 3" {...LINE} style={{ stroke: accent }} />
      </Act>
      <Panel x={34.5} y={32} width={9} height={9} rx={2} />
      <Reveal rest={HIDDEN} delay={2}>
        <rect
          {...LINE}
          x={34.5}
          y={32}
          width={9}
          height={9}
          rx={2}
          style={{ stroke: accent }}
        />
        <Dot cx={39} cy={36.5} r={1.5} fill={accent} />
      </Reveal>
    </>
  ),
  subthreads: (accent) => (
    <>
      <circle
        {...LINE}
        cx={8}
        cy={24}
        r={4.5}
        fill="currentColor"
        fillOpacity={0.18}
      />
      <path
        {...LINE}
        d="M12.5 24C18 24 18 12 24 12M12.5 24H24M12.5 24C18 24 18 36 24 36"
      />
      {[
        [12, 0.75],
        [24, 0.45],
        [36, 0.6],
      ].map(([y, progress], index) => (
        <g key={y}>
          <rect
            {...LINE}
            x={24}
            y={y - 3}
            width={20}
            height={6}
            rx={3}
            fill="currentColor"
            fillOpacity={WASH}
          />
          <Reveal
            rest={{ transform: `scaleX(${progress})`, transformOrigin: "left" }}
            delay={delayAt(index + 1)}
          >
            <rect
              x={25}
              y={y - 2}
              width={18}
              height={4}
              rx={2}
              fill="currentColor"
              fillOpacity={index === 1 ? 1 : 0.55}
              style={index === 1 ? { color: accent } : undefined}
            />
          </Reveal>
        </g>
      ))}
    </>
  ),
  "set-up-for-me": (accent) => (
    <>
      <Panel x={5} y={6} width={38} height={36} rx={4} />
      <rect
        x={10}
        y={12}
        width={10}
        height={6}
        rx={3}
        fill="currentColor"
        fillOpacity={0.85}
      />
      <circle cx={17} cy={15} r={2} style={{ fill: "var(--canvas)" }} />
      <Rule x={24} y={15} width={13} soft />
      <rect {...LINE} x={10} y={22} width={10} height={6} rx={3} />
      <Hide>
        <circle {...LINE} cx={13} cy={25} r={1.5} />
      </Hide>
      <Reveal rest={HIDDEN} delay={1}>
        <rect
          x={10}
          y={22}
          width={10}
          height={6}
          rx={3}
          fill="currentColor"
          fillOpacity={0.85}
        />
        <circle cx={17} cy={25} r={2} style={{ fill: "var(--canvas)" }} />
      </Reveal>
      <Rule x={24} y={25} width={10} soft />
      <Rule x={10} y={35} width={28} soft />
      <Reveal
        rest={{ transform: "scaleX(0.7273)", transformOrigin: "left" }}
        delay={2}
      >
        <Rule x={10} y={35} width={22} />
      </Reveal>
      <Reveal rest={{ transform: "translateX(-6px)" }} delay={2}>
        <circle cx={33} cy={35} r={3} style={{ fill: accent }} />
      </Reveal>
    </>
  ),
  phone: (accent) => (
    <>
      <Panel x={14} y={4} width={20} height={40} rx={4.5} />
      <Rule x={21.5} y={8} width={5} soft />
      {[15, 22, 29].map((y, index) => (
        <g key={y}>
          <Dot cx={19} cy={y} r={1.5} />
          <Rule
            x={22}
            y={y}
            width={index === 0 ? 5 : index === 1 ? 6 : 8}
            soft={index !== 0}
          />
        </g>
      ))}
      <Reveal rest={{ opacity: 0, transform: "translateY(-3px)" }}>
        <Dot cx={19} cy={34.5} r={1.5} />
        <Rule x={22} y={34.5} width={7} soft />
      </Reveal>
      <Act motion="pop" delay={2}>
        <Dot cx={31} cy={15} r={2} fill={accent} />
      </Act>
      <Rule x={21} y={39.5} width={6} />
    </>
  ),
  "browser-automation": (accent) => (
    <>
      <Panel x={4} y={7} width={40} height={32} />
      <Rule x={4} y={13.5} width={40} soft />
      <Dot cx={8} cy={10.25} r={1} />
      <Dot cx={11.5} cy={10.25} r={1} />
      <Rule x={16} y={10.25} width={18} soft />
      <Rule x={9} y={19} width={14} />
      <Rule x={9} y={24} width={20} soft />
      <rect {...LINE} x={9} y={29} width={11} height={5} rx={1.5} />
      <Act motion="travel">
        <path
          {...LINE}
          fill="currentColor"
          fillOpacity={1}
          d="M22 27.5v8.5l2.2-2 1.6 3.3 1.3-.6-1.6-3.2h3Z"
        />
      </Act>
      <Act motion="pop" delay={4}>
        <circle cx={38.5} cy={35.5} r={5.5} style={{ fill: accent }} />
        <path
          d="M36 35.5l1.8 1.8 3.2-3.4"
          style={{ stroke: "var(--canvas)" }}
          strokeWidth={1.1}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </Act>
    </>
  ),
  "build-plugin": (accent) => (
    <>
      <Panel x={3} y={6} width={34} height={30} />
      <Rule x={3} y={12} width={34} soft />
      <Dot cx={7} cy={9} r={1} />
      <Dot cx={10.5} cy={9} r={1} />
      <rect
        {...LINE}
        x={8}
        y={17}
        width={10}
        height={13}
        rx={1.5}
        strokeOpacity={SOFT}
      />
      <Rule x={22} y={19} width={10} soft />
      <Rule x={22} y={24} width={7} soft />
      <Act motion="snap">
        <g transform="translate(23 20) scale(1)">
          <path
            {...LINE}
            strokeWidth={1.3}
            d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
            style={{ stroke: accent, fill: "var(--canvas)" }}
          />
        </g>
      </Act>
    </>
  ),
  "open-threads-that-need-me": (accent) => (
    <>
      <Panel x={4} y={6} width={40} height={36} />
      <Rule x={4} y={12} width={40} soft />
      <Dot cx={8} cy={9} r={1} />
      <Dot cx={11.5} cy={9} r={1} />
      {[
        [8, 16],
        [25, 16],
        [8, 29],
        [25, 29],
      ].map(([x, y], index) => (
        <g key={`${x}-${y}`}>
          <rect
            x={x}
            y={y}
            width={15}
            height={10}
            rx={1.5}
            stroke="currentColor"
            strokeWidth={1.1}
            fill="currentColor"
            fillOpacity={index === 1 ? 0.18 : WASH}
            style={index === 1 ? { color: accent } : undefined}
          />
          {index === 1 ? null : (
            <Reveal rest={HIDDEN} delay={delayAt(index + 1)}>
              <rect
                x={x}
                y={y}
                width={15}
                height={10}
                rx={1.5}
                fill="currentColor"
                fillOpacity={0.14}
                style={{ color: accent }}
              />
            </Reveal>
          )}
          <Rule x={x + 3} y={y + 4} width={7} soft />
          <Rule x={x + 3} y={y + 7} width={5} soft />
        </g>
      ))}
    </>
  ),
  "morning-digest": (accent) => (
    <>
      <Act motion="rise">
        <Panel x={12} y={5} width={24} height={24} rx={2} />
        <Rule x={16} y={11} width={12} />
        <rect
          x={16}
          y={15}
          width={14}
          height={1.5}
          rx={0.75}
          style={{ fill: accent }}
        />
        <Rule x={16} y={20} width={10} soft />
      </Act>
      <path
        {...LINE}
        style={{ fill: "var(--canvas)" }}
        d="M6 22.5h36V40a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2Z"
      />
      <path {...LINE} d="M6 23l18 11 18-11" />
    </>
  ),
  "decision-buttons": (accent) => (
    <>
      <path
        {...LINE}
        fill="currentColor"
        fillOpacity={WASH}
        d="M8 5h32a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H16l-6 5v-5H8a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4Z"
      />
      <Rule x={10} y={11} width={22} />
      <Rule x={10} y={16.5} width={15} soft />
      <rect
        x={6}
        y={31}
        width={17}
        height={10}
        rx={3}
        strokeWidth={1.1}
        fillOpacity={0.18}
        style={{ stroke: accent, fill: accent }}
      />
      <Act motion="pop" delay={3}>
        <path d="M10.5 36l2 2 4-4.5" {...LINE} style={{ stroke: accent }} />
      </Act>
      <rect {...LINE} x={26} y={31} width={17} height={10} rx={3} />
      <Rule x={30.5} y={36} width={8} soft />
      <Reveal rest={{ opacity: 0, transform: "translate(8px, 6px)" }}>
        <path
          {...LINE}
          fill="currentColor"
          fillOpacity={1}
          d="M17 37.5v7l1.8-1.6 1.3 2.7 1.1-.5-1.3-2.6h2.5Z"
        />
      </Reveal>
    </>
  ),
  automations: (accent) => (
    <>
      <Panel x={5} y={8} width={30} height={30} />
      <Rule x={5} y={15} width={30} soft />
      <path {...LINE} d="M12 5v6M28 5v6" />
      {[0, 1, 2, 3].map((column) =>
        [0, 1].map((row) => (
          <Dot
            key={`${column}-${row}`}
            cx={11 + column * 6}
            cy={21 + row * 6}
            r={1.25}
          />
        )),
      )}
      <circle
        {...LINE}
        cx={35}
        cy={35}
        r={8.5}
        style={{ fill: "var(--canvas)" }}
      />
      <Act
        motion="spin"
        style={{ transformBox: "view-box", transformOrigin: "35px 35px" }}
      >
        <path d="M35 30.5V35l3 2" {...LINE} style={{ stroke: accent }} />
      </Act>
    </>
  ),
  "queue-or-steer": (accent) => (
    <>
      <path
        {...LINE}
        fill="currentColor"
        fillOpacity={WASH}
        d="M8 5h24a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H14l-5 4v-4H8a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4Z"
      />
      <Dot cx={13} cy={13} r={1.5} />
      <Dot cx={18} cy={13} r={1.5} />
      <Dot cx={23} cy={13} r={1.5} />
      <Act motion="slide">
        <rect
          {...LINE}
          x={12}
          y={30}
          width={32}
          height={11}
          rx={5.5}
          strokeDasharray="3 2.5"
        />
        <Dot cx={18} cy={35.5} r={2} fill={accent} />
        <Rule x={23} y={35.5} width={14} soft />
      </Act>
      <path {...LINE} strokeOpacity={SOFT} d="M8 25v8a2.5 2.5 0 0 0 2.5 2.5" />
    </>
  ),
  "thread-search": (accent) => (
    <>
      {[9, 17, 25, 33].map((y, index) => (
        <g key={y}>
          <Dot cx={6} cy={y} r={1.5} />
          <Rule x={10} y={y} width={index % 2 === 0 ? 16 : 12} soft />
        </g>
      ))}
      <Act motion="sweep">
        <circle
          {...LINE}
          cx={30}
          cy={26}
          r={9}
          style={{ fill: "var(--canvas)" }}
        />
        <circle cx={25.5} cy={26} r={1.75} style={{ fill: accent }} />
        <Rule x={28.5} y={26} width={5} />
        <path {...LINE} strokeWidth={2} d="M36.5 32.5l6 6" />
      </Act>
    </>
  ),
  "command-palette": (accent) => (
    <>
      <Panel x={3} y={4} width={42} height={40} rx={4} />
      <circle {...LINE} cx={9.5} cy={12} r={2.5} />
      <path {...LINE} d="M11.3 13.8l1.7 1.7" />
      <Rule x={16} y={12} width={8} soft />
      <Act motion="press">
        <rect
          {...LINE}
          x={29}
          y={7}
          width={13}
          height={10}
          rx={2}
          style={{ fill: "var(--canvas)" }}
        />
        <text
          x={35.5}
          y={14.4}
          fontSize={7}
          fontWeight={600}
          textAnchor="middle"
          fill="currentColor"
          fontFamily="inherit"
        >
          ⌘K
        </text>
      </Act>
      <Rule x={3} y={20.5} width={42} soft />
      <Act motion="fade" delay={1}>
        <rect
          x={6}
          y={24}
          width={36}
          height={6}
          rx={2}
          fill="currentColor"
          fillOpacity={WASH * 1.5}
        />
        <Dot cx={10} cy={27} r={1.5} fill={accent} />
        <Rule x={14} y={27} width={18} />
      </Act>
      <Act motion="fade" delay={2}>
        <Dot cx={10} cy={34} r={1.5} />
        <Rule x={14} y={34} width={14} soft />
      </Act>
      <Act motion="fade" delay={3}>
        <Dot cx={10} cy={40} r={1.5} />
        <Rule x={14} y={40} width={20} soft />
      </Act>
    </>
  ),
  "provider-usage": (accent) => (
    <>
      <path {...LINE} d="M5 6v36h38" />
      <path
        {...LINE}
        strokeOpacity={SOFT}
        strokeDasharray="2.5 2.5"
        d="M5 13h38"
      />
      {[
        [10, 22],
        [18, 15],
        [26, 28],
        [34, 19],
      ].map(([x, height], index) => (
        <Act
          key={x}
          motion="grow"
          delay={delayAt(index)}
          style={{ transformOrigin: "bottom" }}
        >
          <rect
            x={x}
            y={42 - height}
            width={5}
            height={height}
            rx={1.5}
            stroke="currentColor"
            strokeWidth={1.1}
            fill="currentColor"
            fillOpacity={index === 1 ? 0.25 : WASH * 1.6}
            style={index === 1 ? { color: accent } : undefined}
          />
        </Act>
      ))}
    </>
  ),
};

export function TipArt({ tipId, tone }: { tipId: string; tone: TipTone }) {
  const draw = ART[tipId] ?? ART["whats-new"];
  return (
    <svg
      aria-hidden
      viewBox="0 0 48 48"
      className="tip-art size-16 shrink-0"
      style={{ color: "color-mix(in oklch, var(--ink) 82%, var(--canvas))" }}
    >
      {draw?.(TONE_COLOR[tone])}
    </svg>
  );
}
