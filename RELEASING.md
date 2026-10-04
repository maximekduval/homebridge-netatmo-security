# Releasing

How a new version of `homebridge-netatmo-security-mk` reaches npm and the
Homebridge UI.

## Steps

1. Add a `## X.Y.Z` section at the top of `CHANGELOG.md` for the next version,
   in a pull request or on `master`. `npm test` fails when the version in
   `package.json` has no changelog section, and `npm publish` runs the tests
   first, so a release cannot go out without notes.
2. Bump the version, which commits `Release X.Y.Z` and creates the tag
   `vX.Y.Z`, then push both:

   ```sh
   npm version patch -m "Release %s"
   git push --follow-tags
   ```

3. Publish to npm with `npm publish`.
4. On GitHub, go to Releases > Draft a new release, choose the existing tag
   `vX.Y.Z`, leave the description empty and publish. The **Release notes**
   workflow then copies the `## X.Y.Z` section of `CHANGELOG.md` into the
   description of the release.

## Release notes in the Homebridge UI

When a plugin is updated, the Homebridge UI shows the description of the GitHub
release `vX.Y.Z` as the release notes, and `CHANGELOG.md` as the full changelog.
It reads both from the GitHub repository found in `homepage`, or else `bugs`, of
`package.json`, with anonymous requests. So:

- the repository must be public, otherwise the UI shows "Could not retrieve
  release notes";
- the GitHub release must exist with a description that is not empty, which the
  **Release notes** workflow takes care of.

To fill a release that already exists, or to create one for an existing tag, run
the **Release notes** workflow from the Actions tab and give it the tag, for
example `v1.0.19`. A description written by hand is never overwritten. Check
`latest` only for the newest version: GitHub marks a new release as the latest
one, and an older version must not take that label. To preview the notes of a
version, run `node scripts/changelog-section.mjs 1.0.19`.
