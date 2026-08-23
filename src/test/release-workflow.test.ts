import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

const workflow = readFileSync(
  path.resolve(__dirname, '../../.github/workflows/release.yml'),
  'utf8',
);
const packageVerifier = readFileSync(
  path.resolve(__dirname, '../../scripts/release/verify-macos-app.sh'),
  'utf8',
);

it('wydaje macOS na dedykowanym runnerze repozytorium i używa tylko sekretów Apple', () => {
  expect(workflow).toContain('runs-on: [self-hosted, macOS, ARM64, justcode, tilemap-generator]');
  expect(workflow).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
  expect(workflow).not.toContain('npm version');

  const secrets = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]);
  expect(new Set(secrets)).toEqual(new Set([
    'APPLE_APP_SPECIFIC_PASSWORD',
    'DEVELOPER_ID_APPLICATION_P12',
    'DEVELOPER_ID_APPLICATION_P12_PASSWORD',
  ]));
});

it('weryfikuje osobno pełny SemVer, numeryczną wersję Apple i entitlement allow-jit', () => {
  expect(workflow).toContain('bundle_version=${version%%-*}');
  expect(workflow).toContain('"$RELEASE_VERSION" "$RELEASE_BUNDLE_VERSION" "$TILEMAP_BUILD_NUMBER"');
  expect(packageVerifier).toContain('[[ "$packaged_version" == "$release_version" ]]');
  expect(packageVerifier).toContain('[[ "$actual_bundle_version" == "$bundle_version" ]]');
  expect(packageVerifier).toContain("plutil -extract 'com\\.apple\\.security\\.cs\\.allow-jit'");
});

it('publikuje updater z tego samego publicznego repo bez PAT', () => {
  expect(workflow).toContain('actions/upload-pages-artifact@');
  expect(workflow).toContain('actions/deploy-pages@');
  expect(workflow).toContain('https://justcodepl.github.io/tilemap-generator/updates/');
  expect(workflow).toContain('https://github.com/$GITHUB_REPOSITORY/releases/download/');
  expect(workflow).not.toContain('tilemap-generator-releases');
  expect(workflow).not.toContain('RELEASES_REPO_TOKEN');
  expect(workflow).not.toMatch(/uses:\s+[^@\s]+@(main|master|v\d+)\s*$/m);
});

it('chroni certyfikat i nie kasuje feedu przy błędzie pobrania', () => {
  expect(workflow).toContain('umask 077');
  expect(workflow).toMatch(/security import "\$certificate_path"[\s\S]+?rm -f "\$certificate_path"/);
  expect(workflow).toContain('fetch_previous_manifest stable');
  expect(workflow).toContain('fetch_previous_manifest beta');
  expect(workflow).toContain('404) rm -f "$temporary"');
  expect(workflow).not.toContain('previous-stable-RELEASES.json');
  expect(workflow).toContain('signing_probe="$RUNNER_TEMP/tilemap-signing-probe"');
  expect(workflow).toContain('TeamIdentifier=$APPLE_TEAM_ID');
});
