import t3CodeIcon from "../assets/competitors/t3-code.png";
import type { Comparison } from "./comparisons";
import {
  CLOSER,
  FAQ_AGENTS,
  FAQ_CODEX_TOGETHER,
  FAQ_CUSTOMIZE,
  FAQ_GET_STARTED,
  FAQ_PERMISSIONS,
  FAQ_PRIVACY,
  FAQ_REVIEW,
  FAQ_SUBSCRIPTIONS,
  cell,
  faqFree,
  faqPhone,
  faqPlatforms,
  faqSchedule,
  faqTalk,
  faqTeam,
  faqUsageLimit,
  price,
} from "./compare-content";
import { pluginsSection } from "./compare-sections";
import { AgentSplit, type BrandLogo } from "./compare-visuals";

const T3_CODE_LOGO: BrandLogo = { kind: "image", src: t3CodeIcon };

const CUSTOMIZE_SECTION = pluginsSection({
  title: "Change anything, no fork needed",
  body: (
    <>
      <p>
        bb comes with worktrees, diffs, automations, and a mobile app built in.
      </p>
      <p>
        When you want something different, browse the{" "}
        <a href="/marketplace">plugin marketplace</a> or ask an agent to build
        it. It’s ready right away, wherever you use bb, including your phone.
      </p>
    </>
  ),
});

export const BB_VS_T3_CODE: Comparison = {
  slug: "t3-code-alternatives",
  title: "T3 Code Alternatives: bb, Where Your Agents Work Together",
  description:
    "bb is a free, open-source T3 Code alternative. Claude Code, Codex, and other agents start and message each other, and plugins let you change anything without forking.",
  competitor: { name: "T3 Code", logo: T3_CODE_LOGO },
  headline: "The T3 Code alternative where your agents work together",
  sub: "Claude Code builds, Codex reviews, and you can message either one. Free and open source, on Mac, Windows, and Linux.",
  heroVisual: <AgentSplit />,
  tailored: CUSTOMIZE_SECTION,
  sections: [],
  tableNote: null,
  table: [
    {
      title: "Price and license",
      rows: [
        {
          feature: "Pricing",
          bb: price("$0", "Any team size"),
          competitor: price("$0", "No paid plan"),
        },
        {
          feature: "Open-source license",
          bb: cell("yes", "MIT"),
          competitor: cell("yes", "MIT"),
        },
      ],
    },
    {
      title: "Agents",
      rows: [
        {
          feature: "Multi-agent support",
          bb: cell("yes", "Claude Code, Codex, Cursor, Pi, and more"),
          competitor: cell("yes", "Claude Code, Codex, Cursor, Pi, and more"),
        },
        {
          feature: "Agent-to-agent handoff",
          bb: cell("yes", "Any provider, each in its own thread"),
          competitor: cell("partial", "Subagents, inside one provider"),
        },
        {
          feature: "Message a subagent",
          bb: cell("yes", "Mid-run, from any device"),
          competitor: cell("no", "Message the parent instead"),
        },
        {
          feature: "Switch accounts at usage limits",
          bb: cell("yes", "Automatic with Account Pooler"),
          competitor: cell("partial", "Tracks limits, you switch"),
        },
      ],
    },
    {
      title: "Customize",
      rows: [
        {
          feature: "Plugin marketplace",
          bb: cell("yes", "Gallery or agent-built"),
          competitor: cell("no", "Fork the code"),
        },
      ],
    },
    {
      title: "Away from your desk",
      rows: [
        {
          feature: "Mobile app",
          bb: cell("yes", "iOS beta, Android alpha"),
          competitor: cell("yes", "iOS and Android"),
        },
        {
          feature: "Run agents on other machines",
          bb: cell("yes", "Any computer you own"),
          competitor: cell("yes", "Pair over LAN, SSH, or relay"),
        },
        {
          feature: "Scheduled automations",
          bb: cell("yes", "Cron, one-shot, scripts"),
          competitor: cell("yes", "Schedules and webhooks"),
        },
      ],
    },
    {
      title: "Workspace",
      rows: [
        {
          feature: "Git worktrees",
          bb: cell("yes", ".env copy, setup, teardown"),
          competitor: cell("yes", "Setup scripts"),
        },
        {
          feature: "Diff review and merge",
          bb: cell("yes"),
          competitor: cell("yes"),
        },
      ],
    },
  ],
  faqTitle: "FAQ",
  faq: [
    {
      title: "Switching from T3 Code",
      items: [
        {
          question: "What’s the difference between bb and T3 Code?",
          answer: (
            <p>
              Both are free, MIT-licensed apps that run Claude Code, Codex, and
              other coding agents in Git worktrees on your own machines, with
              mobile and remote access. In bb, agents start and message each
              other whatever the provider, and every agent they start gets a
              thread you can open and message. You change bb with plugins
              instead of a fork, and Account Pooler moves a thread to your next
              account when one hits its limit.
            </p>
          ),
        },
        {
          question: "Is there a free, open-source T3 Code alternative?",
          answer: (
            <p>
              Yes: bb. It’s free for any team size and MIT-licensed, so you can
              use and change it for anything, including at work. Your agents
              work together across providers, and plugins add whatever you need
              without forking. <a href="/download/macos">Download bb</a>.
            </p>
          ),
        },
        {
          question: "How do I move my projects and worktrees to bb?",
          answer: (
            <p>
              Ask bb to do it. T3 Code keeps each thread’s worktree as plain Git
              on your machine, in <code>~/.t3/worktrees</code>, so a bb agent
              can add your repos and open each unfinished worktree as a thread.
              Your CLAUDE.md, skills, MCP servers, and agent sign-ins come
              along, and T3 Code keeps working while you try bb.
            </p>
          ),
        },
        {
          question: "What’s different day to day?",
          answer: (
            <ul>
              <li>
                When an agent starts another, the new one is a full thread: you
                can message it, and it can be a different provider.
              </li>
              <li>
                Several threads can share one worktree, so a reviewer works
                right next to the agent that wrote the code.
              </li>
              <li>
                Setup commands from <code>t3.json</code> move to{" "}
                <code>.bb-env-setup.sh</code>, and untracked files like{" "}
                <code>.env</code> go in <code>.worktreeinclude</code>.
              </li>
              <li>
                When you want a new panel, command, or agent, you install or
                build a plugin instead of patching the app.
              </li>
            </ul>
          ),
        },
        FAQ_GET_STARTED,
      ],
    },
    {
      title: "Agents",
      items: [
        FAQ_AGENTS,
        {
          question: "Can I message an agent that another agent started?",
          answer: (
            <p>
              Yes. When an agent starts another, the new agent gets its own
              thread in the sidebar. You can read the exact prompt it was given,
              watch it work, and message it mid-run. When it finishes or fails,
              the agent that started it hears back automatically.
            </p>
          ),
        },
        FAQ_CODEX_TOGETHER,
        faqTalk(""),
        faqUsageLimit(
          "T3 Code shows your accounts’ limits, but you switch accounts yourself.",
        ),
        FAQ_PERMISSIONS,
      ],
    },
    {
      title: "Your T3 Code workflow in bb",
      items: [
        {
          question: "Does bb have setup scripts for new worktrees?",
          answer: (
            <p>
              Yes. Commit a <code>.bb-env-setup.sh</code> at your repo root and
              bb runs it in every new worktree. List untracked files like{" "}
              <code>.env</code> in <code>.worktreeinclude</code> and bb copies
              them in first, and <code>.bb-env-teardown.sh</code> cleans up when
              a worktree goes away.
            </p>
          ),
        },
        FAQ_REVIEW,
        {
          question: "Does bb have checkpoints?",
          answer: (
            <p>
              bb lets you rewind the conversation instead. Edit any earlier
              message to rerun the thread from there, or fork a new thread from
              any message to try a different approach. Every change stays on the
              thread’s own Git branch, so nothing lands until you merge it.
            </p>
          ),
        },
        faqPhone(null),
        faqSchedule(null),
        FAQ_CUSTOMIZE,
      ],
    },
    {
      title: "Price, platforms, and privacy",
      items: [
        faqFree(""),
        FAQ_SUBSCRIPTIONS,
        faqPlatforms(null),
        FAQ_PRIVACY,
        faqTeam(""),
      ],
    },
  ],
  closer: CLOSER,
};
