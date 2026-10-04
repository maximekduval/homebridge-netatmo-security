import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { changelogSection } from '../scripts/changelog-section.mjs';

const SCRIPT = fileURLToPath(
  new URL('../scripts/changelog-section.mjs', import.meta.url),
);

const readRepositoryFile = (name) =>
  readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

describe('changelogSection', () => {
  const changelog = [
    '# Changelog',
    '',
    '## 1.0.19',
    '',
    '- Keep isolated failed polls at debug',
    '  level instead of logging an error.',
    '- Log the recovery of an outage.',
    '',
    '## 1.0.18',
    '',
    '- Poll vibration events in their own loop.',
    '',
  ].join('\n');

  it('returns the section of one version, without its heading', () => {
    assert.equal(
      changelogSection(changelog, '1.0.19'),
      [
        '- Keep isolated failed polls at debug level instead of logging an error.',
        '- Log the recovery of an outage.',
      ].join('\n'),
    );
    assert.equal(
      changelogSection(changelog, '1.0.18'),
      '- Poll vibration events in their own loop.',
    );
  });

  it('joins only the wrapped lines of a list item', () => {
    const notes = [
      '## 1.0.0',
      '',
      '### Added',
      '',
      '- First item, wrapped',
      '  on a second line',
      '  and a third one.',
      '  - A nested item',
      '    that wraps too.',
      '1. A numbered item.',
      '',
      '### Fixed',
      '',
      'A paragraph.',
    ].join('\n');

    assert.equal(
      changelogSection(notes, '1.0.0'),
      [
        '### Added',
        '',
        '- First item, wrapped on a second line and a third one.',
        '  - A nested item that wraps too.',
        '1. A numbered item.',
        '',
        '### Fixed',
        '',
        'A paragraph.',
      ].join('\n'),
    );
  });

  it('keeps code blocks as they are', () => {
    const notes = [
      '## 1.0.0',
      '',
      '- Run:',
      '',
      '```sh',
      'npm install',
      '  --flag',
      '## not a heading',
      '```',
      '',
      '- Done.',
      '',
      '## 0.9.0',
      '',
      '- Older.',
    ].join('\n');

    assert.equal(
      changelogSection(notes, '1.0.0'),
      [
        '- Run:',
        '',
        '```sh',
        'npm install',
        '  --flag',
        '## not a heading',
        '```',
        '',
        '- Done.',
      ].join('\n'),
    );
  });

  for (const heading of [
    '## 1.0.19',
    '## v1.0.19',
    '## [1.0.19] - 2026-10-04',
    '## 1.0.19 (2026-10-04)',
    '## [1.0.19](https://example.com/compare/v1.0.18...v1.0.19)',
  ]) {
    it(`finds the heading ${heading}`, () => {
      assert.equal(changelogSection(`${heading}\n\n- Notes.\n`, '1.0.19'), '- Notes.');
    });
  }

  for (const heading of ['## 1.0.190', '## 1.0.19-beta.1', '## 11.0.19']) {
    it(`does not mistake ${heading} for 1.0.19`, () => {
      assert.throws(
        () => changelogSection(`${heading}\n\n- Notes.\n`, '1.0.19'),
        /no "## 1\.0\.19" section/,
      );
    });
  }

  it('accepts Windows line endings and a version with a leading v', () => {
    assert.equal(
      changelogSection(changelog.replace(/\n/g, '\r\n'), 'v1.0.18'),
      '- Poll vibration events in their own loop.',
    );
  });

  it('fails when the version has no section or the section is empty', () => {
    assert.throws(() => changelogSection(changelog, '9.9.9'), /no "## 9\.9\.9" section/);
    assert.throws(
      () => changelogSection('## 1.0.0\n\n## 0.9.0\n\n- Old.\n', '1.0.0'),
      /section of CHANGELOG\.md is empty/,
    );
  });
});

describe('scripts/changelog-section.mjs', () => {
  const run = (...args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  it('prints the notes of a version', () => {
    const { version } = JSON.parse(readRepositoryFile('package.json'));
    const result = run(version);

    assert.equal(result.status, 0);
    assert.equal(
      result.stdout,
      `${changelogSection(readRepositoryFile('CHANGELOG.md'), version)}\n`,
    );
  });

  it('exits with an error when the version has no notes', () => {
    const result = run('0.0.0');

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /no "## 0\.0\.0" section/);
  });

  it('prints its usage without a version', () => {
    const result = run();

    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
  });
});

// Homebridge UI shows the notes of a GitHub release when a plugin is updated,
// and the release notes workflow builds them from CHANGELOG.md (see RELEASING.md).
describe('CHANGELOG.md', () => {
  const changelog = readRepositoryFile('CHANGELOG.md');

  it('has notes for the version in package.json', () => {
    const { version } = JSON.parse(readRepositoryFile('package.json'));

    assert.match(changelogSection(changelog, version), /\S/);
  });

  for (const [, version] of changelog.matchAll(/^## (\d+\.\d+\.\d+)$/gm)) {
    it(`has notes for ${version}`, () => {
      assert.match(changelogSection(changelog, version), /\S/);
    });
  }
});
