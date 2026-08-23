# Wydania macOS i kanały aktualizacji

## Workflow

`.github/workflows/release.yml` uruchamia się dla tagów:

```text
vMAJOR.MINOR.PATCH
vMAJOR.MINOR.PATCH-beta.N
```

Tag musi wskazywać commit obecny na `origin/main`, a wersja w `package.json`
musi być identyczna z wersją tagu. Beta jest GitHub prerelease i nie zastępuje
wydania Stable/Latest.

Build Apple Silicon trafia na istniejący runner organizacji:

```yaml
[self-hosted, macOS, ARM64, justcode, tilemap-generator]
```

Repozytorium jest publiczne, dlatego workflow nie rozszerza dostępu grupy
`Private macOS Builders`. Używa dedykowanego runnera repozytorium
`macbook-pro-artur-tilemap`, zainstalowanego jako osobny LaunchAgent.

## Podpis i notarization

Repozytorium Actions wymaga trzech sekretów zgodnych z SSH Tunnel Manager:

- `DEVELOPER_ID_APPLICATION_P12`;
- `DEVELOPER_ID_APPLICATION_P12_PASSWORD`;
- `APPLE_APP_SPECIFIC_PASSWORD`.

`APPLE_ID=artur.czuba.94@gmail.com` oraz `APPLE_TEAM_ID=4VWT253QFF` są
jawnymi identyfikatorami workflow. P12 trafia wyłącznie do tymczasowego keychaina
w `RUNNER_TEMP`, który jest usuwany także po błędzie.

Zwykłe `npm run package` i `npm run make` nadal używają podpisu ad-hoc dla
developmentu. `TILEMAP_RELEASE_BUILD=1` wymusza Developer ID, hardened runtime,
timestamp i notarization. Pełna wersja SemVer (np. `0.2.0-beta.1`) pozostaje w
`package.json` i jest używana przez aplikację oraz feed. Apple dostaje wymagane
numeryczne `CFBundleShortVersionString` (np. `0.2.0`) oraz rosnący, numeryczny
`CFBundleVersion` z numeru uruchomienia Actions.

## Bramy wydania

Przed publikacją workflow sprawdza:

- TypeScript i pełny zestaw testów;
- zgodność wersji tagu, `package.json`, `Info.plist` i ASAR;
- `codesign --verify --deep --strict`, Team ID i hardened runtime;
- ticket notarization przez `stapler` oraz Gatekeeper przez `spctl`;
- fuses, w tym wyłączone `EnableCookieEncryption`;
- arm64 Sharp i libvips wraz z `@rpath`;
- obecność MCP i start/zamknięcie realnej aplikacji;
- ten sam zestaw kontroli po rozpakowaniu ZIP-a;
- SHA-256 oraz ponowne pobranie draftu release.

Dopiero po tych kontrolach release jest publikowany. Następny job wdraża feed
GitHub Pages, a końcowy job bez poświadczeń pobiera publiczny manifest, ZIP i
checksum, ponownie uruchamia wszystkie kontrole paczki i realny smoke aplikacji.

## Feed aktualizacji

Repozytorium jest publiczne, dlatego updater nie potrzebuje tokenu GitHub.
Podpisany ZIP i `SHA256SUMS` są assetami GitHub Release tego repozytorium, a
Aplikacja najpierw pobiera i waliduje manifest z:

```text
https://justcodepl.github.io/tilemap-generator/updates/{stable|beta}/darwin/arm64/RELEASES.json
```

Beta aktualizuje tylko kanał `beta` i zachowuje poprzedni manifest Stable.
Stable aktualizuje kanały `stable` oraz `beta`, dzięki czemu użytkownik bety
może przejść na finalne wydanie. Dopiero po własnym porównaniu pełnego SemVer
aplikacja przekazuje Squirrel.Mac niezmienny payload `*-update.json` z assetów
konkretnego GitHub Release. GitHub Pages działa w trybie GitHub Actions;
workflow publikuje kompletny artifact strony, a nie wykonuje automatycznych
commitów do `main`.

## Ręczne rozpoczęcie wydania

Po przejściu wszystkich lokalnych kontroli:

```bash
git tag -a v0.2.0-beta.4 -m "Czytelny widok assetu i odporniejsza generacja postaci"
git push origin main
git push origin v0.2.0-beta.4
```

Tag należy wypchnąć dopiero po commicie wersji na `main`. Zakończony zielony
workflow nie zastępuje końcowej kontroli publicznego URL-a i pobranego ZIP-a.
