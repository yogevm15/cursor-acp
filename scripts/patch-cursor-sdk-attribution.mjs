import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sdkEntry = fileURLToPath(import.meta.resolve("@cursor/sdk"));
const distDirectory = resolve(dirname(sdkEntry), "..");

const ORIGINAL_DEFAULT = "!0";
const COMMITS_DEFAULT = '"false"!==process.env.CURSOR_ACP_ATTRIBUTE_COMMITS_TO_AGENT';
const PRS_DEFAULT = '"false"!==process.env.CURSOR_ACP_ATTRIBUTE_PRS_TO_AGENT';

// Minified identifiers change between SDK releases; the surrounding logic must not.
const id = "[\\w$]+";

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitPattern(commitsDefault, prsDefault) {
	const commits = escapeRegExp(commitsDefault);
	const prs = escapeRegExp(prsDefault);
	return new RegExp(
		`(${id})=this\\.attributionConfigProvider\\?\\.get\\(\\),(${id})=!(${id})&&\\(\\1\\?\\.attribution\\?\\.attributeCommitsToAgent\\?\\?${commits}\\),(${id})=!\\3&&\\(\\1\\?\\.attribution\\?\\.attributePRsToAgent\\?\\?${prs}\\)`,
		"g",
	);
}

function bundledPattern(commitsDefault, prsDefault) {
	const commits = escapeRegExp(commitsDefault);
	const prs = escapeRegExp(prsDefault);
	return new RegExp(
		`let (${id})=this\\.attributionConfigProvider\\?\\.get\\(\\);let (${id})=(${id})\\?!1:\\1\\?\\.attribution\\?\\.attributeCommitsToAgent\\?\\?${commits};let (${id})=\\3\\?!1:\\1\\?\\.attribution\\?\\.attributePRsToAgent\\?\\?${prs}`,
		"g",
	);
}

function jsFiles(directory) {
	return readdirSync(join(distDirectory, directory))
		.filter((name) => name.endsWith(".js"))
		.map((name) => join(distDirectory, directory, name));
}

const variants = [
	{ name: "ESM", paths: jsFiles("esm"), pattern: splitPattern },
	{ name: "CommonJS", paths: jsFiles("cjs"), pattern: splitPattern },
	{
		name: "bundled",
		paths: [join(distDirectory, "bundled", "index.js")],
		pattern: bundledPattern,
	},
];

function countMatches(source, pattern) {
	return source.match(pattern)?.length ?? 0;
}

for (const variant of variants) {
	const original = variant.pattern(ORIGINAL_DEFAULT, ORIGINAL_DEFAULT);
	const patched = variant.pattern(COMMITS_DEFAULT, PRS_DEFAULT);
	const originalMatches = [];
	let patchedCount = 0;

	for (const path of variant.paths) {
		const source = readFileSync(path, "utf8");
		const originalCount = countMatches(source, original);
		if (originalCount > 0) {
			originalMatches.push({ path, source, count: originalCount });
		}
		patchedCount += countMatches(source, patched);
	}

	const originalCount = originalMatches.reduce((sum, match) => sum + match.count, 0);
	if (patchedCount === 1 && originalCount === 0) {
		continue;
	}
	if (originalCount !== 1 || patchedCount !== 0) {
		throw new Error(
			`Cannot safely patch @cursor/sdk ${variant.name} attribution logic: expected one original or patched match`,
		);
	}

	const [{ path, source }] = originalMatches;
	writeFileSync(
		path,
		source.replace(original, (match) =>
			match
				.replace(
					`attributeCommitsToAgent??${ORIGINAL_DEFAULT}`,
					`attributeCommitsToAgent??${COMMITS_DEFAULT}`,
				)
				.replace(
					`attributePRsToAgent??${ORIGINAL_DEFAULT}`,
					`attributePRsToAgent??${PRS_DEFAULT}`,
				),
		),
	);
}
