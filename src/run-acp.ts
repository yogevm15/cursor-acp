import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { getAcpMaxMessageBytes, withLenientAgentRequests } from "./acp-wire-compat.js";
import { CursorAcpAgent } from "./cursor-acp-agent.js";
import { nodeToWebReadable, nodeToWebWritable } from "./utils.js";

export function runAcp(): void {
	const input = nodeToWebWritable(process.stdout);
	const output = nodeToWebReadable(process.stdin);
	const stream = withLenientAgentRequests(
		ndJsonStream(input, output, { maxMessageBytes: getAcpMaxMessageBytes() }),
	);
	new AgentSideConnection((client) => new CursorAcpAgent(client), stream);
}
