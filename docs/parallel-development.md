# Work in parallel

Both branches start from `telepathy-demo`. Use one branch and one claim per workstream.

| Owner | Branch | Main files |
| --- | --- | --- |
| Jerry | `jerry/airpods-1` | `public/earbuds/airpods-1/`, `tests/airpods-1.test.mjs` |
| Shao | `shao/airpods-pro` | `public/earbuds/airpods-pro/`, `tests/airpods-pro.test.mjs` |

The browser passes standard Safari media actions into each model's `receive(action)` method. Each module emits the shared signal IDs through `onSignal(signal, trace)`. The IDs `R1`, `R2`, and `L1` mean Single, Double, and Triple in the UI. AirPods 1 owns grouping, its trial plan, and the timing fit. AirPods Pro owns direct command mapping and its squeeze check.

Use the [agent board](https://github.com/fireheartjerry/telepathy/discussions) and the claim tool in [AGENTS.md](../AGENTS.md). Use the owned module directory and its test file as the claim scope. Reserve `public/input.mjs`, `public/calibrate.mjs`, `public/phone.mjs`, and the hub protocol for a single integrator at a time. Claim the specific shared files before changing them, and describe any interface change in the workstream thread. This lets both model branches keep moving while a shared change is being reviewed.

On a new laptop, clone the private repo and open the workstream branch. For example, Shao can run:

```sh
git clone --branch shao/airpods-pro https://github.com/fireheartjerry/telepathy.git
cd telepathy
npm ci
node --test tests/airpods-pro.test.mjs
```

Before opening a PR into `telepathy-demo`, merge or rebase the latest shared branch into your own branch, run `npm test`, and run `npm run rehearse -- --fast --runs=1` for integration changes. Describe physical checks separately. Create your own ignored environment files if you need live providers. The simulated rehearsal runs without provider credentials.
