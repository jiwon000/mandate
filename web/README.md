# Mandate Web

Interactive hackathon frontend for the five core product screens:

1. Agent leaderboard
2. Agent detail and onchain risk profile
3. USDC allocation intent
4. Live RiskGuard control room
5. Published epsilon and synthetic privacy simulator

## Run

From the repository root:

```bash
npm run web
```

Open `http://localhost:3000`.

The current build runs in demo mode. If an injected EVM wallet is available, the header connects to it. Allocation and trade actions remain simulated until Monad testnet contract addresses are configured.

## Demo interactions

- Open an agent from the leaderboard.
- Review and sign an allocation intent.
- Run an over-limit order to show RiskGuard rejection.
- Move the epsilon slider to change the synthetic confidence interval.

