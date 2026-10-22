import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };

const STARTED_AT = new Date();

/** `tsc` rewrites every output file on each build, so this file's mtime is the build time. */
const BUILT_AT: Date | undefined = (() => {
	try {
		return statSync(fileURLToPath(import.meta.url)).mtime;
	} catch {
		return undefined;
	}
})();

function formatLocalTime(date: Date): string {
	return date.toLocaleString("sv-SE");
}

/** Package version with the local build time as semver build metadata, e.g. `0.9.1+20261022173109`. */
export function adapterVersion(): string {
	if (!BUILT_AT) {
		return packageJson.version;
	}
	return `${packageJson.version}+${formatLocalTime(BUILT_AT).replace(/\D/g, "")}`;
}

export function adapterVersionDetails(): string {
	return [
		`${packageJson.name} ${packageJson.version}`,
		`Built: ${BUILT_AT ? formatLocalTime(BUILT_AT) : "unknown"}`,
		`Started: ${formatLocalTime(STARTED_AT)}`,
		`Process: ${process.pid}`,
	].join("\n");
}
