import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

async function getRuntime() {
    try {
        const { Actor } = await import('apify');
        await Actor.init();
        return {
            isApify: true,
            getInput: async () => (await Actor.getInput()) || {},
            pushData: async (item) => {
                try {
                    await Actor.pushData(item, 'bounty-delivered');
                } catch {
                    await Actor.pushData(item);
                }
            },
            charge: async (eventName, count = 1) => {
                if (typeof Actor.charge === 'function') {
                    try {
                        await Actor.charge({ eventName, count });
                    } catch {
                        // Ignore when running outside Pay-Per-Event billing
                    }
                }
            },
            exit: async () => Actor.exit(),
        };
    } catch {
        const inputPath = path.resolve(process.cwd(), 'INPUT.json');
        const localInput = fs.existsSync(inputPath)
            ? JSON.parse(fs.readFileSync(inputPath, 'utf8'))
            : {
                  minRewardUsd: 50,
                  keywords: [],
                  maxResults: 15,
                  includeSources: ['github-bounties', 'algora', 'superteam-gibwork'],
                  standbyMcpServer: false,
              };
        const outDir = path.resolve(process.cwd(), 'storage', 'datasets', 'default');
        fs.mkdirSync(outDir, { recursive: true });
        let counter = 1;
        return {
            isApify: false,
            getInput: async () => localInput,
            pushData: async (item) => {
                const file = path.join(outDir, `${String(counter++).padStart(9, '0')}.json`);
                fs.writeFileSync(file, JSON.stringify(item, null, 2), 'utf8');
            },
            charge: async () => {},
            exit: async () => {},
        };
    }
}

function parseRewardAmountFromText(text = '', labels = []) {
    const combined = `${text} ${labels.join(' ')}`;
    const patterns = [
        /\$\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?/i,
        /(\d{1,3}(?:,\d{3})+|\d+)\s*(?:USD|USDC|USDT|DAI)\b/i,
        /bounty[:\s-]*\$?(\d{2,6})/i,
    ];
    for (const regex of patterns) {
        const match = combined.match(regex);
        if (match && match[1]) {
            const val = Number.parseFloat(match[1].replace(/,/g, ''));
            if (Number.isFinite(val) && val > 0 && val <= 100000) {
                return val;
            }
        }
    }
    return null;
}

function detectRewardToken(text = '', labels = []) {
    const combined = `${text} ${labels.join(' ')}`;
    if (/\bUSDC\b/i.test(combined)) return 'USDC';
    if (/\bUSDT\b/i.test(combined)) return 'USDT';
    if (/\bSOL\b|Solana/i.test(combined)) return 'SOL / USDC';
    if (/\bSATS\b|Lightning|BTC/i.test(combined)) return 'BTC (Lightning)';
    if (/\bETH\b/i.test(combined)) return 'ETH';
    return 'USD / Crypto';
}

async function fetchGitHubBounties(queryStr, sourcePlatform, perPage = 20) {
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(queryStr)}&sort=updated&order=desc&per_page=${perPage}`;
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Apify-Crypto-Bounty-Aggregator-MCP/1.0',
            Accept: 'application/vnd.github+json',
        },
    });
    if (!res.ok) {
        throw new Error(`GitHub API HTTP ${res.status}`);
    }
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    const results = [];

    for (const issue of items) {
        const labelNames = Array.isArray(issue.labels)
            ? issue.labels.map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean)
            : [];
        const bodySnippet = typeof issue.body === 'string' ? issue.body.slice(0, 600) : '';
        const rewardAmountUsd = parseRewardAmountFromText(`${issue.title} ${bodySnippet}`, labelNames) || 100;
        const rewardToken = detectRewardToken(`${issue.title} ${bodySnippet}`, labelNames);
        const repoPath = issue.repository_url
            ? issue.repository_url.replace('https://api.github.com/repos/', '')
            : 'unknown/repo';

        const cleanTitle = String(issue.title || '').replace(/\u2014/g, '-');
        results.push({
            id: `gh-${issue.id}`,
            title: cleanTitle,
            rewardAmountUsd,
            rewardToken,
            sourcePlatform,
            repository: repoPath,
            labels: labelNames,
            commentsCount: issue.comments || 0,
            url: issue.html_url,
            createdAt: issue.created_at,
            updatedAt: issue.updated_at,
        });
    }
    return results;
}

export async function aggregateBounties({
    minRewardUsd = 50,
    keywords = [],
    maxResults = 25,
    includeSources = ['github-bounties', 'algora', 'superteam-gibwork'],
} = {}) {
    const collected = new Map();
    const keywordQuery =
        Array.isArray(keywords) && keywords.length > 0
            ? ` ${keywords.map((k) => k.trim()).filter(Boolean).join(' ')}`
            : '';

    const queries = [];
    if (includeSources.includes('github-bounties')) {
        queries.push({
            q: `is:issue is:open label:bounty "$" -label:claimed${keywordQuery}`,
            platform: 'GitHub Bounties',
        });
    }
    if (includeSources.includes('algora')) {
        queries.push({
            q: `is:issue is:open "algora.io" "$" -label:claimed${keywordQuery}`,
            platform: 'Algora.io / GitHub',
        });
    }
    if (includeSources.includes('superteam-gibwork')) {
        queries.push({
            q: `is:issue is:open ("USDC" OR "Solana" OR "bounty") "$" state:open${keywordQuery}`,
            platform: 'Web3 / USDC Ecosystem',
        });
    }

    for (const qItem of queries) {
        try {
            const batch = await fetchGitHubBounties(qItem.q, qItem.platform, 20);
            for (const b of batch) {
                if (b.rewardAmountUsd >= minRewardUsd && !collected.has(b.url)) {
                    collected.set(b.url, b);
                }
            }
        } catch (err) {
            console.warn(`[Crypto-Bounty-MCP] Source query warning (${qItem.platform}): ${err.message}`);
        }
    }

    return Array.from(collected.values())
        .sort((a, b) => b.rewardAmountUsd - a.rewardAmountUsd)
        .slice(0, maxResults);
}

function startMcpHttpServer(runtime, defaultInput) {
    const port = Number(process.env.ACTOR_WEB_SERVER_PORT || process.env.PORT || 4321);
    const server = http.createServer(async (req, res) => {
        if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
                JSON.stringify({
                    status: 'ok',
                    actor: 'crypto-bounty-aggregator-mcp',
                    mcpEndpoint: '/mcp',
                })
            );
            return;
        }

        if (req.method === 'POST' && req.url?.startsWith('/mcp')) {
            let body = '';
            req.on('data', (chunk) => {
                body += chunk;
            });
            req.on('end', async () => {
                try {
                    const rpc = JSON.parse(body || '{}');
                    if (rpc.method === 'tools/list') {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(
                            JSON.stringify({
                                jsonrpc: '2.0',
                                id: rpc.id ?? 1,
                                result: {
                                    tools: [
                                        {
                                            name: 'search_crypto_bounties',
                                            description:
                                                'Fetches live open-source and Web3 bounties paid in USD, USDC, SOL, or BTC with reward filtering.',
                                            inputSchema: {
                                                type: 'object',
                                                properties: {
                                                    minRewardUsd: { type: 'number', default: 50 },
                                                    keywords: { type: 'array', items: { type: 'string' } },
                                                    maxResults: { type: ' integer', default: 15 },
                                                },
                                            },
                                        },
                                    ],
                                },
                            })
                        );
                        return;
                    }

                    if (rpc.method === 'tools/call') {
                        const args = rpc.params?.arguments || {};
                        const bounties = await aggregateBounties({
                            minRewardUsd: args.minRewardUsd ?? defaultInput.minRewardUsd ?? 50,
                            keywords: args.keywords ?? defaultInput.keywords ?? [],
                            maxResults: args.maxResults ?? defaultInput.maxResults ?? 15,
                        });
                        await runtime.charge('mcp-tool-call', 1);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(
                            JSON.stringify({
                                jsonrpc: '2.0',
                                id: rpc.id ?? 1,
                                result: {
                                    content: [
                                        {
                                            type: 'text',
                                            text: JSON.stringify(bounties, null, 2),
                                        },
                                    ],
                                },
                            })
                        );
                        return;
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(
                        JSON.stringify({
                            jsonrpc: '2.0',
                            id: rpc.id ?? null,
                            result: {
                                protocolVersion: '2024-11-05',
                                serverInfo: { name: 'crypto-bounty-aggregator-mcp', version: '1.0.0' },
                                capabilities: { tools: {} },
                            },
                        })
                    );
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            });
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    });

    server.listen(port, () => {
        console.log(`[Crypto-Bounty-MCP] Standby MCP HTTP Server listening on port ${port} (/mcp)`);
    });
}

async function run() {
    const runtime = await getRuntime();
    const input = await runtime.getInput();

    const minRewardUsd = typeof input.minRewardUsd === 'number' ? input.minRewardUsd : 50;
    const keywords = Array.isArray(input.keywords) ? input.keywords : [];
    const maxResults = Number(input.maxResults) || 15;
    const includeSources =
        Array.isArray(input.includeSources) && input.includeSources.length > 0
            ? input.includeSources
            : ['github-bounties', 'algora', 'superteam-gibwork'];

    console.log(
        `[Crypto-Bounty-MCP] Querying live bounties (minRewardUsd: $${minRewardUsd}, maxResults: ${maxResults})...`
    );

    const bounties = await aggregateBounties({
        minRewardUsd,
        keywords,
        maxResults,
        includeSources,
    });

    for (const item of bounties) {
        await runtime.pushData(item);
        await runtime.charge('bounty-delivered', 1);
    }

    console.log(`[Crypto-Bounty-MCP] Exported ${bounties.length} active technical bounties.`);

    if (input.standbyMcpServer || process.env.APIFY_META_ORIGIN === 'STANDBY') {
        startMcpHttpServer(runtime, input);
    } else {
        await runtime.exit();
    }
}

run();
