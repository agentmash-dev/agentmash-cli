# crew

The [agentmash crew](https://github.com/agentmash-dev/agentmash-crew): 22 Claude Code agents, Mash the conductor among them, vendored at [v1.3.1](https://github.com/agentmash-dev/agentmash-crew/tree/v1.3.1) (commit `2ae56e145be0e2fa2eba744296edbe8bcd5342a3`). `npx agentmash team`, the one-click pull request on agentmash.dev and the /agents pages all read these files, so a team installed any of those ways is the same bytes, and the same as the crew's own installer writes but for one line in each agent file: the model it runs on (see [models](#models)). The install format is specified upstream in [docs/bundle-format.md](https://github.com/agentmash-dev/agentmash-crew/blob/v1.3.1/docs/bundle-format.md).

| file | where it comes from | what it is for |
| --- | --- | --- |
| `bundle.json` | `dist/bundle.json`, with the models from `tools/crew-models.json` | every file an install writes, the team skill template and the guard hook |
| `catalog.json` | `catalog.json`, with the same models | the /agents pages, and the agent names the server routes accept |
| `team-plan.mjs` | `lib/team-plan.mjs` | the pure planner (`planChange`) the CLI and the server both run |
| `install.mjs` | `lib/install.mjs` | the file-system side the CLI runs (`runTeamOp`, `listTeams`, `loadBundle`) |
| `team-plan.d.mts` | this repo, `tools/crew-team-plan.d.mts` | TypeScript declarations for `team-plan.mjs` |
| `crew.lock.json` | the sync | the tag, the commit and the sha256 of every other file here |

## Models

Each agent file has a `model:` line, and Claude Code runs the agent on that model. The release picks one per agent; the sync sets agentmash's own over it, from `tools/crew-models.json`, in the agent's file in `bundle.json` (and the sha256 the bundle keeps for it) and in `catalog.json`, which the /agents pages show. Nothing else in the release changes. `scout-explorer` runs on haiku. `lingo-i18n`, `bump-dependencies` and `quill-docs` run on sonnet. The other 18 say `inherit`: the model of the session that called them. None is put on opus or fable. Against the release, an agent costs more per token only here: `gavel-reviewer` and `snag-debugger`, on opus in the release, now follow the session and cost more when it runs on fable. The table says why for each.

A repository with a team already in it gets these lines from `npx agentmash team update`. An agent file someone changed by hand is kept as it is, as the planner keeps any file changed locally. The crew's own installer writes the release's models; run `npx agentmash team update` after it to put these back.

| agent | model | in the release | why |
| --- | --- | --- | --- |
| `mash-coordinator` | inherit | inherit | runs the plan and checks every claim the crew makes |
| `tally-planner` | inherit | inherit | edits nothing, but planning is judgment, not lookup |
| `scout-explorer` | haiku | sonnet | read-only: maps the code with path:line citations and edits nothing |
| `flex-frontend` | inherit | inherit | writes and edits code |
| `pipe-backend` | inherit | inherit | writes and edits code |
| `swipe-mobile` | inherit | inherit | writes and edits code |
| `index-database` | inherit | inherit | writes migrations |
| `patch-integrations` | inherit | inherit | writes and edits code |
| `batch-ml` | inherit | inherit | writes and edits code and notebooks |
| `spell-prompts` | inherit | inherit | edits prompts and checks them against evals |
| `lingo-i18n` | sonnet | sonnet | edits locale catalogs; stays on the release's sonnet, since inherit would cost more on an opus session |
| `probe-qa` | inherit | inherit | writes tests |
| `gavel-reviewer` | inherit | opus | edits nothing, but a review is judgment: on haiku it would miss bugs |
| `snag-debugger` | inherit | opus | finds root causes and edits the fix |
| `prune-refactor` | inherit | inherit | writes and edits code |
| `bump-dependencies` | sonnet | sonnet | edits manifests and lockfiles; stays on the release's sonnet, since inherit would cost more on an opus session |
| `rail-cicd` | inherit | inherit | writes and edits pipelines |
| `quill-docs` | sonnet | sonnet | edits docs; stays on the release's sonnet, since inherit would cost more on an opus session |
| `higgs-video` | inherit | inherit | picks models and spends credits on a paid service |
| `plain-editor` | inherit | inherit | edits copy |
| `tempo-motion` | inherit | inherit | writes and renders compositions |
| `inspo-scrap` | inherit | inherit | design judgment over live sites and screenshots |

## Never edit by hand

Everything here is written by `tools/sync-crew.mjs`, and `cli/test/crew-lock.test.mjs` re-hashes it against `crew.lock.json`, so a hand edit fails the tests. A change to an agent, the bundle or the planner goes upstream, gets a tag, and comes here by a sync. Two inputs are kept in this repo: the declarations, `tools/crew-team-plan.d.mts`, and the models, `tools/crew-models.json`. Edit either and sync again.

## Updating

```bash
git -C ../agentmash-crew fetch --tags
git -C ../agentmash-crew checkout v<new version>
node tools/sync-crew.mjs --from ../agentmash-crew
```

The script refuses a checkout that has local changes or is not exactly at the tag, and checks every file against the blob in the tagged commit. Review the diff of `crew/`, run the tests, and commit `crew/` with its lock. The CLI package carries its own copy of these files, so people running `npx agentmash` get a new crew version, or new models, with the next CLI release.

## License

`bundle.json`, `catalog.json`, `team-plan.mjs` and `install.mjs` are copied from [agentmash-crew](https://github.com/agentmash-dev/agentmash-crew) and are under its MIT License:

    MIT License

    Copyright (c) 2026 Damir Iskakov

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
