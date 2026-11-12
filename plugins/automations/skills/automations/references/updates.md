`list` and `show` are diagnostic reads: a damaged record remains visible as
`Prompt required` or `Invalid data` instead of failing the whole read. A
`Prompt required` record opens in the Automations panel's standard editor,
where the user can add its prompt while reviewing the other settings. It can
also be repaired directly:

```bash
bb automation update <automationId> --project <id> --prompt "<prompt>"
```

Writes remain strict. Run, pause, and resume reject damaged records; update
succeeds only when the resulting complete record is canonical. Every successful
create/update persists the canonical format.

An update is a patch: every flag you omit keeps its stored value.

- On an agent automation, use any combination of `--prompt`, `--provider`,
  `--model`, `--reasoning`, `--service-tier`, and
  `--permission-mode accept-edits|auto|full`, then choose at most one execution
  target. A new `--provider` drops the stored service tier unless you pass
  one, and keeps the stored permission mode only when the new provider
  supports it (otherwise its default). Pass the new provider's `--model` too.
- On a script automation, use any combination of `--script`/`--script-file`,
  `--interpreter`, `--timeout`, `--env-json`, and `--working-directory`. A new
  `--script-file` infers its interpreter from its extension when it has one;
  otherwise the stored interpreter stays.
- Switching modes replaces the execution: `--prompt`, `--provider`, and
  `--model` together turn a script automation into an agent, and
  `--script`/`--script-file` turn an agent automation into a script. Settings
  of the previous mode do not carry over.

Execution targets for an agent automation:

```bash
bb automation update <automationId> --project <id> \
  --environment <environment-id-or-path>
bb automation update <automationId> --project <id> \
  --target-thread <thread-id>
bb automation update <automationId> --project <id> \
  --new-environment worktree [--base-branch <branch>]
```

`--target-thread`, `--environment`, and `--new-environment` are mutually
exclusive. These flags apply only to agent automations; script automations have
no execution environment.

For a script automation, update only its working-directory policy without
replacing the stored script:

```bash
bb automation update <automationId> --project <id> \
  --working-directory automation-storage|project|<absolute-server-path>
```

Every command supports `--json`. For `list` and `show`, the JSON result is a
union discriminated by `problem`: canonical records omit it, while degraded
records use `"missing-agent-prompt"` or `"invalid-stored-data"`. The
missing-prompt variant retains the full readable automation; the invalid-data
variant contains only `id`, `projectId`, `name`, and `problem`.
