import type { ReactNode, SVGProps } from "react";
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
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  fill: "none",
} as const;

const WASH = 0.07;
const SOFT = 0.35;

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
      <path
        d="M39 6.5c.5 3 1.5 4 4.5 4.5-3 .5-4 1.5-4.5 4.5-.5-3-1.5-4-4.5-4.5 3-.5 4-1.5 4.5-4.5Z"
        style={{ fill: accent }}
      />
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
      <path d="M30 33.5l3.5 3-3.5 3" {...LINE} style={{ stroke: accent }} />
      <Panel x={34.5} y={32} width={9} height={9} rx={2} />
    </>
  ),
  subthreads: (accent) => (
    <>
      <Panel x={4} y={5} width={24} height={9} rx={2.5} />
      <Dot cx={8.5} cy={9.5} />
      <Rule x={12} y={9.5} width={11} />
      <path {...LINE} d="M9 14v24M9 19.5h7M9 29h7M9 38.5h7" />
      {[19.5, 29, 38.5].map((y, index) => (
        <g key={y}>
          <Panel x={16} y={y - 3.5} width={27} height={7} rx={2} />
          <Dot
            cx={20}
            cy={y}
            r={1.5}
            fill={index === 1 ? accent : "currentColor"}
          />
          <Rule x={23.5} y={y} width={index === 2 ? 9 : 13} soft />
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
      <circle {...LINE} cx={13} cy={25} r={1.5} />
      <Rule x={24} y={25} width={10} soft />
      <Rule x={10} y={35} width={28} soft />
      <Rule x={10} y={35} width={16} />
      <circle cx={27} cy={35} r={3} style={{ fill: accent }} />
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
      <Dot cx={31} cy={15} r={2} style={{ fill: accent }} />
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
      <path
        {...LINE}
        fill="currentColor"
        fillOpacity={1}
        d="M22 27.5v8.5l2.2-2 1.6 3.3 1.3-.6-1.6-3.2h3Z"
      />
      <circle cx={38.5} cy={35.5} r={5.5} style={{ fill: accent }} />
      <path
        d="M36 35.5l1.8 1.8 3.2-3.4"
        style={{ stroke: "var(--canvas)" }}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </>
  ),
  "build-plugin": (accent) => (
    <>
      <rect
        {...LINE}
        x={4}
        y={18}
        width={30}
        height={26}
        rx={3}
        strokeOpacity={SOFT}
      />
      <path
        {...LINE}
        fill="currentColor"
        fillOpacity={WASH}
        d="M9 27h6.5a3 3 0 1 1 6 0H28v12H9Z"
      />
      <path
        {...LINE}
        fillOpacity={0.15}
        d="M30 5h13v13H30v-4a2.5 2.5 0 1 0 0-5Z"
        style={{ stroke: accent, fill: accent }}
      />
      <path
        {...LINE}
        strokeOpacity={SOFT}
        d="M27 20.5l-2.5 2.5M31 22.5l-1.5 1.5"
      />
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
            strokeWidth={1.5}
            fill="currentColor"
            fillOpacity={index === 1 ? 0.18 : WASH}
            style={index === 1 ? { color: accent } : undefined}
          />
          <Rule x={x + 3} y={y + 4} width={7} soft />
          <Rule x={x + 3} y={y + 7} width={5} soft />
        </g>
      ))}
    </>
  ),
  "morning-digest": (accent) => (
    <>
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
        strokeWidth={1.5}
        fillOpacity={0.18}
        style={{ stroke: accent, fill: accent }}
      />
      <path d="M10.5 36l2 2 4-4.5" {...LINE} style={{ stroke: accent }} />
      <rect {...LINE} x={26} y={31} width={17} height={10} rx={3} />
      <Rule x={30.5} y={36} width={8} soft />
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
      <path d="M35 30.5V35l3 2" {...LINE} style={{ stroke: accent }} />
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
      <rect
        {...LINE}
        x={12}
        y={30}
        width={32}
        height={11}
        rx={5.5}
        strokeDasharray="3 2.5"
      />
      <Dot cx={18} cy={35.5} r={2} style={{ fill: accent }} />
      <Rule x={23} y={35.5} width={14} soft />
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
      <circle
        {...LINE}
        cx={30}
        cy={26}
        r={9}
        style={{ fill: "var(--canvas)" }}
      />
      <circle cx={25.5} cy={26} r={1.75} style={{ fill: accent }} />
      <Rule x={28.5} y={26} width={5} />
      <path {...LINE} strokeWidth={2.5} d="M36.5 32.5l6 6" />
    </>
  ),
  "command-palette": (accent) => (
    <>
      <Panel x={4} y={6} width={40} height={11} />
      <circle {...LINE} cx={10} cy={11.5} r={2.5} />
      <path {...LINE} d="M12 13.5l1.5 1.5" />
      <rect {...LINE} x={33} y={8.5} width={8} height={6} rx={1.5} />
      <text
        x={37}
        y={13.1}
        fontSize={4.5}
        textAnchor="middle"
        fill="currentColor"
        fontFamily="inherit"
      >
        ⌘K
      </text>
      <rect
        x={4}
        y={21}
        width={40}
        height={7}
        rx={2}
        fill="currentColor"
        fillOpacity={WASH * 1.6}
      />
      <Dot cx={9} cy={24.5} r={1.5} style={{ fill: accent }} />
      <Rule x={13} y={24.5} width={18} />
      <Dot cx={9} cy={33} r={1.5} />
      <Rule x={13} y={33} width={14} soft />
      <Dot cx={9} cy={40} r={1.5} />
      <Rule x={13} y={40} width={20} soft />
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
        <rect
          key={x}
          x={x}
          y={42 - height}
          width={5}
          height={height}
          rx={1.5}
          stroke="currentColor"
          strokeWidth={1.5}
          fill="currentColor"
          fillOpacity={index === 1 ? 0.25 : WASH * 1.6}
          style={index === 1 ? { color: accent } : undefined}
        />
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
      className="mb-2.5 size-11 shrink-0 text-foreground"
    >
      {draw?.(TONE_COLOR[tone])}
    </svg>
  );
}
