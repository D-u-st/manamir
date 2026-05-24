# Skills

Skills are file-based capabilities the LLM can invoke. Each skill is a folder
containing a `manifest.json` and a markdown body. The model loads them on
demand via the `skill_load` tool.

## Where skills live

```
data/profiles/<profile>/skills/
  my-skill/
    manifest.json
    body.md
  another-skill/
    manifest.json
    body.md
    helper.sh        (optional supporting files)
```

## manifest.json

```json
{
  "name": "post-pr-review",
  "description": "Walk through a code review checklist for a PR diff",
  "tier": "standard",
  "version": "1.0.0",
  "trustHash": "auto",
  "tags": ["dev", "review"]
}
```

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Slug, must match folder name. `[a-z0-9-]+`. |
| `description` | yes | One sentence. The model sees this in `/skills` listings. |
| `tier` | yes | `read-only`, `standard`, or `dangerous` |
| `version` | yes | Semver |
| `trustHash` | no | SHA-256 of the body, computed automatically if `"auto"` |
| `tags` | no | For filtering |

## Tiers

| Tier | When invokable | Confirmation? |
|---|---|---|
| `read-only` | Always | None |
| `standard` | After user trusts the skill once | None per-invocation after trust |
| `dangerous` | After admin trusts the skill | Each invocation requires `confirm=true` |

The tier defines a **policy** — actual blocking happens in `src/skills/security.ts`.
A skill author *declares* the tier; the user (or admin) decides whether to trust it.

## Trust workflow

First time a skill is invoked, Manamir:

1. Computes the SHA-256 of `body.md`.
2. Compares with `trustHash` in the manifest.
3. If hash mismatch → refuses to load (skill was modified after trust was granted).
4. If `tier=standard` and not yet trusted → returns a permission error to the model
   with a hint: "ask the user to run `/skill_trust <name>`".
5. After the user runs `/skill_trust`, the hash is recorded in `data/profiles/<p>/skills/_trust.json`.

## Body format

The body is markdown. There's no special template — the model reads it as
context when the skill is loaded.

Example `body.md`:

````markdown
# post-pr-review

When reviewing a PR diff, walk through this checklist in order:

1. **Behavior change** — what does the user-visible behavior look like before
   and after? Is it documented in the PR description?
2. **Tests** — does the change have tests? Run them. Look for edge cases.
3. **Style** — does it match the surrounding code? Check imports, naming.
4. **Security** — any user input parsing? Path traversal? SQL injection vectors?
5. **Performance** — any new O(n²) loops? DB queries inside loops?

Output: bullet list of findings with file:line refs, grouped by severity.

Tools you'll likely need:
- `Bash` — to run `git diff`, `git log`, `npm test`
- `Read` — to view changed files in context
- `Grep` — to find related call sites
````

## SkillSynth — auto-generated skills

When a turn completes successfully and used 3+ tools, the SkillSynth extractor
(if `EXECUTOR_TYPE=api` and credentials are set) sends the trace to the LLM
with a prompt like:

> Here's a successful tool sequence. If this is a generic capability worth
> abstracting into a reusable skill, write the skill's manifest and body.
> Otherwise, respond `SKIP`.

The result is written under `data/profiles/<p>/skills/skillSynth/<name>/`. By
default SkillSynth-extracted skills are `tier=standard` and untrusted — review
before trusting.

See `src/skills/skillSynth-extractor.ts`.

## Writing your own skill — minimal example

```bash
mkdir -p data/profiles/default/skills/hello-world
cat > data/profiles/default/skills/hello-world/manifest.json << 'EOF'
{
  "name": "hello-world",
  "description": "Say hello in a friendly way",
  "tier": "read-only",
  "version": "1.0.0",
  "trustHash": "auto"
}
EOF
cat > data/profiles/default/skills/hello-world/body.md << 'EOF'
When invoked, respond with a friendly greeting that mentions the current time.
EOF
```

Restart Manamir. The skill should appear in `/skills`. Ask the bot:

```
> use the hello-world skill
```

The model will invoke `skill_load("hello-world")`, read the body, and follow
its instructions.

## Listing & loading from inside a turn

The model has these tools:

- `skill_list` — list all available skills (name + description)
- `skill_load <name>` — load a skill's body into the conversation

It uses them autonomously. You don't usually need to invoke them directly.

## Versioning

Bump `version` whenever you change `body.md`. The body's hash is recorded at
trust time; if you edit the body without bumping the version, the hash mismatch
will block loading until re-trusted.

## Security notes

- `dangerous` skills can do anything any tool can do. Audit them before trusting.
- Skills cannot self-modify (the policy in `src/security/path-policy.ts` blocks
  writes to the skills directory from tool calls).
- SkillSynth skills are NEVER auto-trusted. Always review.
