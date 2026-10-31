import { describe, expect, test } from "bun:test";

import { isWanchainHost, normalizeEndpointUrl, normalizeRpcUrl } from "../../src/registry/_url.ts";
import {
  extractObjectBlock,
  parseChainlistChainFile,
  parseChainlistExtraRpcs,
  parseRpcPage,
} from "../../.dev/sources.ts";

const CHAIN_URL = "https://example.test/chainid-999.js";

describe("source parsers", () => {
  test("reads the HyperEVM rpc array and skips the testnet url in the same file", () => {
    const source = `
      export const data = {
        "name": "HyperEVM",
        "chainId": 999,
        "rpc": [
          "https://rpc.hyperliquid.xyz/evm/",
          "wss://hyperliquid.drpc.org",
          "https://rpc.hyperliquid-testnet.xyz/evm"
        ]
      }
    `;
    const endpoints = parseChainlistChainFile(source, CHAIN_URL);
    expect(endpoints.map((endpoint) => endpoint.url)).toEqual([
      "https://rpc.hyperliquid.xyz/evm",
      "wss://hyperliquid.drpc.org/",
    ]);
    expect(endpoints.find((endpoint) => endpoint.url.startsWith("wss:"))?.kind).toBe("websocket");
  });

  test("ignores a chain 999 file that is not HyperEVM", () => {
    const source = `{ "name": "Wanchain Testnet", "chainId": 999, "rpc": ["https://gwan-ssl.wandevs.org:46891/"] }`;
    expect(parseChainlistChainFile(source, CHAIN_URL)).toEqual([]);
  });

  test("drops wandevs.org hosts and keeps urls that only contain that text", () => {
    const source = `
      { "name": "HyperEVM", "chainId": 999, "rpc": [
        "https://rpc.hyperliquid.xyz/evm",
        "https://gwan-ssl.wandevs.org:46891/",
        "https://Wandevs.org/evm",
        "wss://rpc.wandevs.org/ws",
        "https://notwandevs.org/evm",
        "https://wandevs.org.evil.example/evm",
        "https://rpc.example/wandevs.org"
      ]}
    `;
    expect(parseChainlistChainFile(source, CHAIN_URL).map((endpoint) => endpoint.url)).toEqual([
      "https://rpc.hyperliquid.xyz/evm",
      "https://notwandevs.org/evm",
      "https://wandevs.org.evil.example/evm",
      "https://rpc.example/wandevs.org",
    ]);
  });

  test("reads only the 999 block of extraRpcs and keeps the tracking field", () => {
    const source = `
      998: { rpcs: ["https://rpc.hyperliquid-testnet.xyz/evm"] },
      999: {
        rpcs: [
          {
            url: "https://lb.routeme.sh/rpc/evm/999",
            tracking: "limited",
          },
          "https://rpc.example/secret?api-key=1",
          {
            url: "https://rpc.nodeflare.app/hl/public",
            tracking: "none",
          },
        ],
      },
      1001: { rpcs: ["https://other.example/rpc"] },
    `;
    expect(extractObjectBlock(source, "999")).toContain("nodeflare");
    const endpoints = parseChainlistExtraRpcs(source, "https://example.test/extraRpcs.js");
    expect(endpoints.map((endpoint) => endpoint.url)).toEqual([
      "https://lb.routeme.sh/rpc/evm/999",
      "https://rpc.nodeflare.app/hl/public",
    ]);
    expect(endpoints[0]?.tracking).toBe("limited");
    expect(endpoints[1]?.tracking).toBe("none");
  });

  test("keeps RPC-shaped links from a page and drops the rest", () => {
    const html = `
      <a href="https://www.chainindex.dev/chains/hyperevm">page</a>
      <a href="https://hyperfoundation.org/">home</a>
      <a href="https://rpc.purroofgroup.com">rpc</a>
      <a href="https://rpc.hyperliquid-testnet.xyz/evm">testnet</a>
      <a href="https://creativecommons.org/licenses/by/4.0/">license</a>
    `;
    const endpoints = parseRpcPage(html, "openchainbench", "https://openchainbench.com/benchmarks/hyperliquid-rpc");
    expect(endpoints.map((endpoint) => endpoint.url)).toEqual(["https://rpc.purroofgroup.com/"]);
  });
});

describe("normalizeRpcUrl", () => {
  test("rejects queries, credentials, and non-RPC schemes", () => {
    expect(normalizeRpcUrl("https://RPC.Example/evm/").url).toBe("https://rpc.example/evm");
    expect(() => normalizeRpcUrl("https://user:pass@rpc.example/evm")).toThrow(/credentials/);
    expect(() => normalizeRpcUrl("https://rpc.example/evm?key=1")).toThrow(/query/);
    expect(() => normalizeRpcUrl("ftp://rpc.example/evm")).toThrow(/http/);
    expect(() => normalizeRpcUrl("not a url")).toThrow(/Invalid RPC URL/);
  });

  test("endpoint normalization also rejects malformed URLs", () => {
    expect(() => normalizeEndpointUrl("not a url")).toThrow(/Invalid RPC URL/);
  });
});

describe("isWanchainHost", () => {
  test("matches the hostname exactly or as a subdomain", () => {
    expect(isWanchainHost("https://wandevs.org/evm")).toBe(true);
    expect(isWanchainHost("https://Wandevs.org:46891/")).toBe(true);
    expect(isWanchainHost("wss://gwan-ssl.wandevs.org:46891/")).toBe(true);
    expect(isWanchainHost("https://notwandevs.org/evm")).toBe(false);
    expect(isWanchainHost("https://wandevs.org.evil.example/evm")).toBe(false);
    expect(isWanchainHost("https://rpc.example/wandevs.org")).toBe(false);
    expect(isWanchainHost("https://rpc.example/evm?host=wandevs.org")).toBe(false);
    expect(isWanchainHost("not a url")).toBe(false);
  });
});
