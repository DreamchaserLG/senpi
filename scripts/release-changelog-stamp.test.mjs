import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CHANGELOGS, dropEmptySubsections, stampChangelogs } from "./release-changelog.mjs";

describe("a stamped release section carries no empty subsection headings", () => {
	it("drops headings with no entries and keeps the ones that have entries", () => {
		const section = "## [1.1.0] - 2026-02-01\n\n### Breaking Changes\n\n### Added\n\n- A\n\n### Fixed\n\n### Removed\n\n";
		assert.equal(dropEmptySubsections(section), "## [1.1.0] - 2026-02-01\n\n### Added\n\n- A\n\n");
	});

	it("keeps a heading whose body is prose or a nested list, not only '- ' bullets", () => {
		const section = "## [1.1.0] - 2026-02-01\n\n### Changed\n\nThe catalog is refreshed.\n\n### Fixed\n\n  - nested\n";
		assert.equal(dropEmptySubsections(section), section);
	});

	it("leaves only the header when every subsection is empty", () => {
		assert.equal(dropEmptySubsections("## [1.1.0] - 2026-02-01\n\n### Changed\n\n### Fixed\n\n"), "## [1.1.0] - 2026-02-01\n\n");
	});

	it("stampChangelogs writes the released section without empty headings and leaves older sections alone", () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-stamp-"));
		const cwd = process.cwd();
		try {
			const older = "## [2026.10.19] - 2026-10-19\n\n### Breaking Changes\n\n### Fixed\n\n- old\n";
			for (const file of CHANGELOGS) {
				mkdirSync(join(root, file, ".."), { recursive: true });
				writeFileSync(join(root, file), `# Changelog\n\n## [Unreleased]\n\n### Breaking Changes\n\n### Fixed\n\n- new\n\n### Removed\n\n${older}`);
			}
			process.chdir(root);
			const captured = new Map();
			stampChangelogs("2026.10.20", "2026-10-20", false, captured, () => {}, () => {});
			assert.equal(
				readFileSync("packages/server/CHANGELOG.md", "utf8"),
				`# Changelog\n\n## [2026.10.20] - 2026-10-20\n\n### Fixed\n\n- new\n\n${older}`,
			);
			// The next cycle's [Unreleased] placeholders still come from the headings the section had before stamping.
			assert.deepEqual(captured.get("packages/server/CHANGELOG.md"), ["### Breaking Changes", "### Fixed", "### Removed"]);
		} finally {
			process.chdir(cwd);
			rmSync(root, { recursive: true, force: true });
		}
	});
});
