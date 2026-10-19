import { readFileSync, writeFileSync } from "node:fs";

export const CHANGELOGS = [
	"packages/ai/CHANGELOG.md",
	"packages/agent/CHANGELOG.md",
	"packages/coding-agent/CHANGELOG.md",
	"packages/senpi-codemode/CHANGELOG.md",
	"packages/server/CHANGELOG.md",
	"packages/tui/CHANGELOG.md",
];

export const DEFAULT_UNRELEASED_SUBSECTIONS = [
	"### Breaking Changes",
	"### Added",
	"### Changed",
	"### Fixed",
	"### Removed",
];

export function extractUnreleasedSubsections(content) {
	const lines = content.split("\n");
	const start = lines.findIndex((line) => line.trim() === "## [Unreleased]");
	if (start === -1) {
		return null;
	}
	const subsections = [];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith("## [")) {
			break;
		}
		if (line.startsWith("### ")) {
			subsections.push(line);
		}
	}
	return subsections;
}

// The captured shape used to be copied verbatim, so one malformed block propagated
// to every following release cycle.
const UNRELEASED_SUBSECTION_ALIASES = new Map([
	["### New Features", "### Added"],
	["### Features", "### Added"],
	["### Fixes", "### Fixed"],
	["### Bug Fixes", "### Fixed"],
]);

export function canonicalizeUnreleasedSubsections(subsections) {
	const seen = new Set();
	for (const raw of subsections) {
		const heading = raw.trim();
		if (heading.length === 0) continue;
		seen.add(UNRELEASED_SUBSECTION_ALIASES.get(heading) ?? heading);
	}
	const canonical = DEFAULT_UNRELEASED_SUBSECTIONS.filter((heading) => seen.has(heading));
	const extras = [...seen].filter((heading) => !DEFAULT_UNRELEASED_SUBSECTIONS.includes(heading));
	return [...canonical, ...extras];
}

export function resolveNextUnreleasedSubsections(capturedSubsections) {
	if (capturedSubsections === undefined || capturedSubsections === null) {
		return DEFAULT_UNRELEASED_SUBSECTIONS;
	}
	const canonical = canonicalizeUnreleasedSubsections(capturedSubsections);
	return canonical.length > 0 ? canonical : DEFAULT_UNRELEASED_SUBSECTIONS;
}

export function buildUnreleasedBlock(subsections) {
	let block = "## [Unreleased]\n\n";
	for (const sub of subsections) {
		block += `${sub}\n\n`;
	}
	return block;
}

export function insertUnreleasedBlock(content, version, date, block) {
	if (extractUnreleasedSubsections(content) !== null) {
		return content;
	}
	const target = `## [${version}] - ${date}`;
	if (content.includes(target)) {
		return content.replace(target, () => `${block}${target}`);
	}
	const changelogTitle = "# Changelog\n\n";
	if (content.startsWith(changelogTitle)) {
		return `${changelogTitle}${block}${content.slice(changelogTitle.length)}`;
	}
	return `${block}${content}`;
}

/**
 * Drop the `### ` subsection headings that have no content from a released section. [Unreleased] keeps empty
 * placeholder headings between releases (reAddUnreleasedSections), but a stamped release section should list only
 * what shipped.
 */
export function dropEmptySubsections(section) {
	const lines = section.split("\n");
	const kept = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith("### ")) {
			let next = i + 1;
			while (next < lines.length && lines[next].trim() === "") next++;
			if (next === lines.length || lines[next].startsWith("### ") || lines[next].startsWith("## [")) {
				i = next - 1;
				continue;
			}
		}
		kept.push(lines[i]);
	}
	// Keep the separator the section had before the next "## [" header.
	const trailing = /\n*$/.exec(section)?.[0] ?? "";
	return kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, trailing);
}

function stampReleaseSection(content, header) {
	const stamped = content.replace(/^## \[Unreleased\]$/m, header);
	const start = stamped.indexOf(header);
	const after = stamped.indexOf("\n## [", start + header.length);
	const end = after === -1 ? stamped.length : after + 1;
	return stamped.slice(0, start) + dropEmptySubsections(stamped.slice(start, end)) + stamped.slice(end);
}

export function stampChangelogs(version, date, dryRun, capturedSubsections, log, dryRunLog) {
	log(`stamping ${CHANGELOGS.length} CHANGELOG.md files: [Unreleased] -> [${version}] - ${date}`);
	for (const file of CHANGELOGS) {
		const content = readFileSync(file, "utf-8");
		const subsections = extractUnreleasedSubsections(content);
		if (subsections === null) {
			log(`  skip ${file}: no [Unreleased] section`);
			continue;
		}
		capturedSubsections.set(file, subsections);
		const updated = stampReleaseSection(content, `## [${version}] - ${date}`);
		const count = subsections.length;
		const noun = count === 1 ? "subsection header" : "subsection headers";
		if (dryRun) {
			dryRunLog(`write ${file} ([Unreleased] -> [${version}] - ${date}; ${count} ${noun} captured)`);
			continue;
		}
		writeFileSync(file, updated);
		log(`  stamped ${file} (${count} ${noun} captured)`);
	}
}

export function reAddUnreleasedSections(version, date, dryRun, capturedSubsections, log, dryRunLog) {
	log(`re-inserting [Unreleased] block in ${CHANGELOGS.length} CHANGELOG.md files`);
	for (const file of CHANGELOGS) {
		const subsections = resolveNextUnreleasedSubsections(capturedSubsections.get(file));
		const block = buildUnreleasedBlock(subsections);
		const count = subsections.length;
		const noun = count === 1 ? "placeholder" : "placeholders";
		if (dryRun) {
			dryRunLog(
				`insert [Unreleased] block in ${file} (${count} ${noun})`,
			);
			continue;
		}
		const content = readFileSync(file, "utf-8");
		const updated = insertUnreleasedBlock(content, version, date, block);
		if (updated === content) {
			log(`  skip ${file}: [Unreleased] already exists`);
			continue;
		}
		writeFileSync(file, updated);
		log(`  re-added [Unreleased] to ${file}`);
	}
}
