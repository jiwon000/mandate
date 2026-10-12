# Submission status

Mandate's entry for the Monad Metropolis hackathon, Track 1 (Onchain Finance & Trading). This folder holds the texts entered in the submission form and the logo. What is built and what is not is described in the root [README](../../README.md) ("Implementation status", "Honest limitations" and "Roadmap"); this page covers the submission only.

- Deadline: 2026-10-13 23:59 ET (2026-10-14 12:59 KST)
- Last updated: 2026-10-12
- Form: <https://hackathon.monad.xyz/project?tab=submission> (team login required)
- Team: @jiwon000, @yahamang

## Summary

- Every required field of the form is filled. The form shows "Ready for judging" (last saved 2026-10-12 02:28 UTC) and says judges review the latest saved entry after the deadline.
- The three videos (demo, pitch, Perpl bounty) are public on YouTube and open without a login.
- The hosted demo <https://mandate-e4kb.onrender.com> runs on Monad testnet (chainId 10143) and needs no wallet, except for the Launch screen.
- The hosted demo deploys a new set of contracts by itself after a visitor freezes a vault, so its current addresses can differ from the table in the README's "Recorded run on Monad testnet". The current ones are at `/api/deployment` on the demo. The contracts in the table stay on chain.

## Videos

| Video | Link | Length | Form field |
| --- | --- | --- | --- |
| Technical demo | <https://youtu.be/7KrvWPyJ8qg> | 2:26 | Technical demo video (limit 3:00) |
| Pitch | <https://youtu.be/DP9q64eadq0> | 1:42 | Pitch video (limit 2:00) |
| Perpl bounty | <https://youtu.be/xW7opngMXiU> | 1:37 | Video field of the Perpl bounty (limit 2:00) |

All three are in English, 1280×720, with burned-in captions and a synthetic voice (`edge-tts`). The demo is a recording of the hosted demo with narration, made on 2026-10-11. The pitch is slides with narration. The Perpl video shows the 2026-10-10 agent run and the "Agent runs" table of [`docs/perpl-adapter.md`](../perpl-adapter.md#agent-runs). Korean cuts of the demo (2:39) and the pitch (1:55) exist and are not uploaded. Video files are not kept in the repository.

## Files in this folder

| File | Contents |
| --- | --- |
| [`description.txt`](description.txt) | Form field "Description" |
| [`go-to-market.txt`](go-to-market.txt) | Form field "Go-to-market and user acquisition strategy" |
| [`judge-access.txt`](judge-access.txt) | Form field "Judge access instructions": a walkthrough of the hosted demo |
| [`mandate-logo.png`](mandate-logo.png), [`mandate-logo.source.html`](mandate-logo.source.html) | Logo uploaded to the form (1024×1024) and its source |

The three `.txt` files are the source of the form texts. A change is made in the file first and then pasted into the form, and the form is read back to check that the two match. They were last pasted on 2026-10-11, and the saved entry was read back and found identical to the three files on 2026-10-12.

The form texts were drafted with an AI coding tool (Claude Code). See "AI tool disclosure" in the root README.

## Submission requirements

From sections 4.1 and 9 of the hackathon's Rules & Guidelines (version of 2026-09-03, read on 2026-10-04). One team submits one project to one track. There are five judging criteria at 20% each: Product Quality & Completeness, Technical Excellence, Monad Integration, Track Fit & Problem Relevance, Innovation & Impact.

| Requirement | Where it is met |
| --- | --- |
| Public GitHub repository with full source, setup instructions, an open-source licence, credit for third-party code and commit history from the build period | This repository. MIT [`LICENSE`](../../LICENSE); README "Local development" and "Third-party code" |
| Disclosure of AI coding tools in the README | README "AI tool disclosure" |
| Demo video: three minutes or less, public link, showing the product working and interacting with Monad | <https://youtu.be/7KrvWPyJ8qg> |
| Deployed on Monad mainnet or testnet, with contract addresses or transaction hashes | README "Recorded run on Monad testnet" |
| Explanation of why the project uses Monad | `description.txt`: the mark-age argument |
| Documentation: description, architecture, tech stack, setup and deployment | Root README |
| Submission on the platform | Saved; see the next table |

## Submission form

| Field | Required | Value |
| --- | --- | --- |
| Primary track | yes | Onchain Finance & Trading |
| Project logo | yes | `mandate-logo.png` |
| Project name | yes | `Mandate` |
| One-line description | yes | Entered in the form |
| Description | yes | `description.txt` |
| Go-to-market and user acquisition strategy | yes | `go-to-market.txt` |
| GitHub repository | yes | `https://github.com/jiwon000/mandate` |
| Live product | yes | `https://mandate-e4kb.onrender.com/` |
| Technical demo video | yes | `https://youtu.be/7KrvWPyJ8qg` |
| Pitch video | yes | `https://youtu.be/DP9q64eadq0` |
| Judge access instructions | no | `judge-access.txt` |
| Sponsor bounty | no | Perpl, "Best use of Perpl's API". System link: `docs/perpl-adapter.md#agent-runs`. Video: `https://youtu.be/xW7opngMXiU` |
| Sponsor bounty | no | Monad Foundation, "Best Community Team Project". Community: HYBLOCK |
| Show demo video publicly, Show pitch video publicly | no | No (both) |
| Product advertisement, X profile | no | Empty |

## Left before the deadline

1. Walk through steps 1 to 9 of `judge-access.txt` on the hosted demo once more (steps 10 to 14 are optional).
2. Read the saved entry on the form's "REVIEW ENTRY" page as a team. The button has not been pressed yet. Whether a further submit step follows it has not been checked; the form already shows the entry as ready for judging.

## Notes on the hosted demo

The settings and safeguards are documented in "Live testnet demo" in the root README. These are the points that matter while the demo is being judged.

- The host is a Render web service running in live mode (chainId 10143). The instance sleeps when nobody has visited for a while, so the first load is slow.
- On boot, `web/live-recover.mjs` finds the most recent complete deployment on chain and uses it. A restart does not redeploy and does not depend on the committed `web/deployments/10143.json`.
- When a visitor freezes a vault, the server deploys a new set of contracts (`AUTO_RESET_MIN_FROZEN=1`). Earlier deployments stay on chain.
- Launch on the hosted demo works only from a browser wallet, and the visitor's wallet pays the gas.
- Pending intents, claim proofs and reporter samples are held in memory and are lost on a restart.
- Opening the page or `/api` makes the oracle post a price every 5 seconds for 60 seconds, which spends the deploy account's testnet MON. With no visitors it posts once an hour (`ORACLE_IDLE_SECONDS=3600`), so the first order after a quiet period can be refused once with `MarkTooOld`. `judge-access.txt` says so.
- The ε budget on the Privacy screen covers 100 releases and starts again with each deployment.
- The noise pledge was checked on the hosted demo on 2026-10-11 with `contracts/script/verify-noise.mjs`: epoch 1 was pledged just before its release and reads `late-pledge`; from epoch 2 on the releases read `verified`.

## Rules for the texts and videos

- The only reason given for Monad is the mark-age argument: a mandate can only demand a price as fresh as the chain's block interval allows. No general claims about speed or cost.
- The 12-second-block comparison exists only in the local build. Even in that mode orders pass for a few seconds after each price update, so the texts do not say that nothing passes.
- No traction that does not exist (users, partners, interviews). What is not built is described as planned.
- The venue and the USDC in the hosted demo are mocks, and the price is posted by the team's keeper. The texts say so.
- The statistics on the Privacy screen are computed from public vault prices. The texts do not claim that private data is protected.
- The agent that ran on Perpl's testnet exchange is a rule-based script. There is no partnership with Perpl and no profit claim.
- No mnemonic, `.env` or `#admin=` / `?admin=` address appears in a video or screenshot.
