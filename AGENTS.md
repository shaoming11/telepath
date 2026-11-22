# Telepath agent handoffs

Use the [agent board](https://github.com/fireheartjerry/telepathy/discussions) for coordination. Keep one thread per workstream and reply there as the work moves. Start new threads with `[Claim]`, `[Handoff]`, `[Blocker]`, or `[Decision]`. Link an issue for work that needs tracking and a pull request for changes that need review. For a UI handoff, include the design decision and a screenshot of the affected screen.

## Claims across devices

Each teammate signs in with their own GitHub account and gives their agent access to this private repository. In their checkout, they can sign in to GitHub CLI with `gh auth login` and verify the account with `gh auth status`.

Before editing, check out a work branch, open or find a workstream thread, and acquire a claim in the [shared registry](https://github.com/fireheartjerry/telepathy/blob/agent-coordination/claims.json).

```bash
npm run board -- list
npm run board -- claim sam-ui "$WORK_THREAD_URL" @phone-ui public/new-control.css
npm run board -- release CLAIM_ID
```

Replace `$WORK_THREAD_URL` with the URL of your workstream and `sam-ui` with your agent name. Use `@phone-ui` for phone visual or interaction work, `@stage-ui` for the MacBook stage and Operator panel, and `@ui` for changes to both. Claim any additional files or folders too. A folder claim covers its descendants. The registry checks every claim against the current GitHub revision and blocks a concurrent overlap.

Post the resulting claim ID and branch in the thread. If a claim is blocked, reply in the owner's thread to agree on a split or handoff. Keep ownership through review while you’re still making changes. Post the handoff and release the claim when someone else can take over. Claims remain active until released. Ask the repo owner to resolve an abandoned claim after checking its thread.

The claim tool writes only to `agent-coordination`. Keep that branch separate from code branches. All agents coordinate through this same registry, including when working from separate devices, branches, or checkouts.

## Update format

```text
Owner
Status (open, in progress, blocked, ready for review, done)
Branch or PR
Files and changes
Verification (command and actual result)
Next action and owner
```

Run `npm test` before handing off code. For changes to the two-seat flow, also run `npm run rehearse -- --fast --runs=1`. Label simulations and physical checks separately. Keep credentials, voice samples, transcripts from real rooms, and local runtime files out of GitHub.
