# Releasing

How a new version of `homebridge-netatmo-security-mk` reaches npm and the Homebridge UI.

## Steps

1. In a pull request, bump the version without creating a tag:

   ```sh
   npm version patch --no-git-tag-version
   ```

   This updates `version` in `package.json` and `package-lock.json`. Add a
   `## X.Y.Z` section at the top of `CHANGELOG.md` in the same pull request.
   `npm test` fails when the version has no changelog section, so a release
   cannot go out without notes. Merge it once CI is green.
2. On GitHub, go to Releases > Draft a new release, create the tag `vX.Y.Z` on
   `master`, leave the description empty and publish.
3. Two workflows start by themselves:
   - **Release** stages the package on npm. It first checks that the tag
     matches `version` in `package.json` and is on `master`.
   - **Release notes** copies the `## X.Y.Z` section of `CHANGELOG.md` into the
     description of the GitHub release.
4. Approve the staged version with 2FA on npmjs.com (package > Versions), or run
   `npm stage approve homebridge-netatmo-security-mk@X.Y.Z`. npm first validates the
   package for a couple of minutes; the approval is available after that.

Do not run `npm publish` or `npm version` with a tag on your machine: the
version and the tag come from the pull request and the GitHub release.

The **Release** workflow authenticates with npm trusted publishing, configured
on npmjs.com for this repository and `release.yml` with the stage-only
permission, so no npm token is stored in GitHub. That configuration is tied to
the repository name and the workflow file name: if either is renamed, update the
trusted publisher in the package settings on npmjs.com before the next release,
or the **Release** workflow is refused.

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
example `v1.0.20`. A description written by hand is never overwritten. Check
`latest` only for the newest version: GitHub marks a new release as the latest
one, and an older version must not take that label. To preview the notes of a
version, run `node scripts/changelog-section.mjs 1.0.20`.
