# Demo video script (form field: Technical demo video)

- Video: <https://youtu.be/7KrvWPyJ8qg> (English, 2:26). A Korean cut with the same scenes (2:39) exists and is not uploaded.
- Form rule: three minutes or less, a working product, no slides or code walkthroughs.
- Recorded on 2026-10-11, 04:49 to 04:57 UTC, on the hosted demo <https://mandate-e4kb.onrender.com> (Monad testnet, chainId 10143). The recording and editing scripts are in [`demo-video/`](demo-video/README.md).
- The narration below is what the video says. The source files are [`demo-video/scenes.json`](demo-video/scenes.json) (English) and [`demo-video/scenes.ko.json`](demo-video/scenes.ko.json) (Korean); this table is a copy. The voice is synthetic (`edge-tts`).
- The video follows one vault from start to finish. The badge at the top left ("Acting as: …") shows which role is acting.

## Scenes

| # | On screen | Narration |
| --- | --- | --- |
| 0 | Opening screen, then the vault cards on Market | If you hand money to someone else's trading agent, you have to trust whoever runs it: not to take the money, and not to take more risk than they promised. Mandate turns that trust into contract terms. This is the live app on Monad testnet. Each card is a vault that an agent trades. Its limits, like maximum drawdown and leverage, are locked in the vault contract. The ring shows how much of the drawdown limit is still unused, and the status shows whether the agent may trade. In this video I play three roles: the operator who opens a vault, the allocator who funds it, and the agent that trades it. |
| 1 | Launch: pick a preset, then one `createMandate()` from a browser wallet | Anyone can open a vault. Pick a preset, and one transaction deploys the vault, sets its terms and locks them before the first deposit. The operator cannot change them afterwards. |
| 2 | The allocator puts 1,000 into Tight Mandate | Now I am an allocator. I put a thousand test USDC into Tight Mandate. The money goes to the vault contract. The agent can trade it, but it can never withdraw it. |
| 3 | Two agent orders: one inside the terms passes, one past the limit is refused with `PositionNotionalExceeded` | Now I am the agent. An order inside the terms passes the risk guard and executes. An order past the limit is refused before it reaches the venue, and the feed shows the contract's own error. |
| 4 | −2% shock, `poke()` freezes the vault, the agent's order is refused (`AgentNotActive`), one `unwind()` step | The market drops two percent, and this vault is now past its three percent drawdown limit. Anyone can act on that. Poke freezes the agent and pays the caller a small bounty. The agent's next order is refused, and the position is closed in public steps. |
| 5 | The allocator withdraws from the frozen vault | The allocator is never locked in. Withdrawals stay open through the freeze. |
| 6 | The mark age tile, then the poke transaction on the explorer (`testnet.monadscan.com`) | This vault refuses any price older than ten seconds. A mandate can only demand a price as fresh as its chain's blocks allow, and that is why Mandate is built on Monad. Every action here is a testnet transaction, like this poke on the explorer. |
| 7 | The Perpl panel on Market | In this demo the venue and the USDC are mocks. The same guard also runs against Perpl's testnet exchange. Over five runs, a rule-based script had twenty orders filled and nine over-limit orders refused on chain. |

## Left out of the video

These did not fit in the time. They are in the root README and in [`judge-access.txt`](judge-access.txt).

- The full list of terms with recommended ranges, and the fee structure
- The kinds of freeze (permanent, daily-loss pause, resumable freeze after a price outage) and `resume()`
- The withdrawal queue (`requestRedeem`)
- The Batch and Privacy screens. The optional steps in `judge-access.txt` walk through both.
- The 12-second-block comparison. That switch exists only in the local build.

## Rules the video follows

- The only reason given for Monad is the mark-age argument.
- It says the demo's venue and USDC are mocks. It does not claim a partnership with Perpl or that the hosted demo trades on Perpl.
- The agent that ran on Perpl's testnet is a rule-based script. No profit is claimed.
- No mnemonic, `.env` or `#admin=` address appears on screen.
