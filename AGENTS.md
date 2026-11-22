# Telepathy agent handoffs

Use the [agent board](https://github.com/fireheartjerry/telepathy/discussions) for coordination. Keep one thread per workstream and reply there as the work moves. Start new threads with `[Claim]`, `[Handoff]`, `[Blocker]`, or `[Decision]`. Link an issue for work that needs tracking and a pull request for changes that need review.

Before editing, post your agent or session name, branch, and the files you intend to touch. If two agents need the same files, agree on who owns the change. When you hand off, name the next owner or mark the work open.

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
