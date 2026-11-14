# Releasing pi-taskbus

Releases are published manually to npm and tagged in Git. The CI workflow validates pull requests and pushes to main on Node.js 22.19.0 and 24, including an isolated tarball installation and extension-loading check. Review the CI results and exercise the resident tree, full-tree navigation, native tool cards, reload, and persistence in a real Pi terminal before publishing.

## Prepare a version

For the initial release, keep package.json at 0.1.0. For subsequent releases, choose the next semantic version and update package.json and package-lock.json together with `npm version patch --no-git-tag-version`, replacing patch with minor or major when appropriate. Add a matching version heading to CHANGELOG.md and describe user-visible changes, migration requirements, and compatibility updates. Update any pinned installation examples in README.md to match the release version.

Run the release checks from a checkout with development dependencies installed:

```sh
npm ci
npm run validate
npm run test:package
npm publish --dry-run
```

The prepublishOnly hook runs validation and the package smoke check whenever npm publish is invoked, including its dry run. The smoke check packs the project, checks its published file list, installs the tarball into a temporary project with host peers omitted, and loads the installed TypeScript extension through the development Pi host. The hook and packaging script remain in the repository, and the published tarball contains the extension source, manifest, license, README, changelog, and example configuration.

## Publish and tag

Check package ownership before publishing. An E404 from npm view means package metadata is unavailable; a response that says Unpublished indicates a previous publication was removed and may be subject to npm's republishing restrictions. Confirm account ownership, name availability, and whether the intended name-and-version pair has been used before. For an existing package, verify that the authenticated account is listed as a maintainer and that the intended version has not already been published.

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm view pi-taskbus name version maintainers --registry=https://registry.npmjs.org/
```

Review and commit the release changes, wait for CI to pass, and publish from that exact checkout using the authentication and two-factor flow required by npm:

```sh
npm publish --access public
```

After npm confirms publication, verify the registry version and create a matching Git tag from the release commit. Replace 0.1.0 with the actual version for later releases.

```sh
npm view pi-taskbus@0.1.0 version dist.integrity --registry=https://registry.npmjs.org/
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

Create a GitHub Release for that tag using the corresponding changelog entry, then verify the public npm installation in a separate Pi profile or temporary agent directory with `pi install npm:pi-taskbus@0.1.0`. The package includes TypeScript source that Pi loads directly, so the release requires no compilation step. npm treats each published name-and-version pair as immutable; fixes to a published release require a new version.
