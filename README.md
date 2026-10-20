# Crypto & Open-Source Bounty Aggregator (MCP Server Ready)

Aggregates active technical bounties paid in USD, USDC, USDT, Solana, and Bitcoin Lightning across GitHub Bounties, Algora.io, and Web3 repositories. Includes a native Model Context Protocol (`MCP`) HTTP server (`/mcp`) for autonomous AI coding agents.

## Core Capabilities

- **Live Bounty Discovery**: Queries open issues carrying verified monetary rewards, Algora bounty tags, and USDC/Solana grants.
- **Reward Normalization**: Extracts numerical USD equivalents (`rewardAmountUsd`) and payout tokens (`USDC`, `SOL`, `BTC`, `USD`) from issue titles, labels, and markdown bodies.
- **Native MCP Server (`/mcp`)**: Exposes the `search_crypto_bounties` tool via JSON-RPC 2.0 so Claude Desktop, Cursor, Windsurf, and autonomous bounty-hunting agents can query high-paying issues on demand.
- **Pay-Per-Event Integration**: Supports programmatic micro-billing (`bounty-delivered` and `mcp-tool-call`) for AI agent workflows.

## Input Configuration

```json
{
  "minRewardUsd": 50,
  "keywords": ["typescript", "python"],
  "maxResults": 20,
  "includeSources": ["github-bounties", "algora", "superteam-gibwork"],
  "standbyMcpServer": false
}
```
