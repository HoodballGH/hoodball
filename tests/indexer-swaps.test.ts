import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Hex } from "viem";
import { swapPoolCandidates, poolContainsToken } from "../lib/swap-detection";
const token = "0x1111111111111111111111111111111111111111";
const pool = "0x2222222222222222222222222222222222222222";
const other = "0x3333333333333333333333333333333333333333";
const event = parseAbiItem("event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)");
const topics = encodeEventTopics({ abi: [event], eventName: "Swap", args: { sender: token, to: other } }) as Hex[];
test("valid V2 swap events identify the emitting pool but transfers and malformed events do not", () => {
  const data = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [10n, 0n, 0n, 20n]);
  assert.deepEqual(swapPoolCandidates([{ address: pool, topics, data }]), [pool]);
  assert.deepEqual(swapPoolCandidates([{ address: pool, topics, data: "0x1234" }]), []);
  const zero = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [0n, 0n, 0n, 20n]);
  assert.deepEqual(swapPoolCandidates([{ address: pool, topics, data: zero }]), []);
  assert.deepEqual(swapPoolCandidates([{ address: pool, topics: [], data: "0x" }]), []);
});
test("swap label requires two valid distinct pool token addresses including this token", () => {
  const encoded = (address: string) => `0x${"0".repeat(24)}${address.slice(2)}`;
  assert.equal(poolContainsToken(token, encoded(token), encoded(other)), true);
  assert.equal(poolContainsToken(token, encoded(other), encoded(pool)), false);
  assert.equal(poolContainsToken(token, encoded(token), "0x"), false);
  assert.equal(poolContainsToken(token, encoded(token), encoded(token)), false);
});
