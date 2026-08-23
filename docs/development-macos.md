# Uruchamianie i rozwój na macOS

## Wymagania

- macOS;
- Node.js 20.19 lub nowszy;
- npm zgodny z lockfile;
- lokalny, zalogowany Codex CLI;
- capability image generation i skill `imagegen` dla providera Codex;
- opcjonalnie Comfy Desktop/ComfyUI albo ręcznie zbudowany `stable-diffusion.cpp`.

## Instalacja i start

```bash
cd /Users/artur/sources/justcode/tilemap-generator
npm install
npm start
```

`prestart` przebudowuje `better-sqlite3` dla ABI Electron. Jeżeli Codex nie jest wykrywany automatycznie:

```bash
export TILEMAP_CODEX_EXE="/pełna/ścieżka/do/codex"
npm start
```

Aplikacja sprawdza między innymi Codex dołączony do `/Applications/ChatGPT.app` oraz typowe lokalizacje Homebrew.

## Moduły natywne

Repozytorium używa dwóch runtime ABI:

- Electron — aplikacja desktopowa;
- Node — Vitest i CLI eksportu.

Skrypty:

```bash
npm run native:electron
npm run native:node
```

`npm test` przełącza addon na Node, a `posttest` przywraca Electron. `npm start` ponownie wymusza Electron. Nie uruchamiaj testów i działającej aplikacji równolegle podczas przebudowy addonu.

Typowy błąd ABI:

```text
The module was compiled against a different Node.js version
NODE_MODULE_VERSION ...
```

Naprawa zależy od procesu, który ma być uruchomiony:

```bash
npm run native:node      # przed ręcznym Vitest/CLI pod Node
npm run native:electron  # przed aplikacją Electron
```

## Testy

```bash
npm run typecheck
npm test
npm run verify
```

`verify` uruchamia TypeScript i pełny Vitest. Testy `live-*` są domyślnie pomijane, ponieważ wymagają prawdziwych usług albo projektu Unity.

Live smoke Codexa bez generowania obrazu:

```bash
TILEMAP_LIVE_CODEX=1 npx vitest run src/test/live-codex.test.ts
```

Po ręcznym uruchomieniu pojedynczego testu wymagającego ABI Node przywróć Electron:

```bash
npm run native:electron
```

## ComfyUI

Domyślne API:

```text
http://127.0.0.1:8188
```

Inny port:

```bash
export TILEMAP_COMFY_URL='http://127.0.0.1:8190'
npm start
```

Akceptowane są wyłącznie adresy loopback. Detekcja Comfy Desktop i gotowość API to dwa osobne sygnały. Zainstalowana aplikacja bez utworzonej i uruchomionej lokalnej instancji pozostaje offline jako provider.

Profil Z-Image Turbo oczekuje:

```text
models/diffusion_models/z_image_turbo_bf16.safetensors
models/text_encoders/qwen_3_4b.safetensors
models/vae/ae.safetensors
```

Workflow alfa wymaga dodatkowo node'ów background removal i:

```text
models/background_removal/birefnet.safetensors
```

## stable-diffusion.cpp na macOS

Zarządzany instalator nie pobiera pakietu Windows na macOS. Zbuduj projekt z backendem Metal, a następnie ustaw:

```bash
export TILEMAP_SD_CPP_EXE="/path/to/stable-diffusion.cpp/build/bin/sd-cli"
export TILEMAP_SD_CPP_MODEL="/path/to/z_image_turbo-Q4_K.gguf"
export TILEMAP_SD_CPP_LLM="/path/to/Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
export TILEMAP_SD_CPP_VAE="/path/to/ae.safetensors"
npm start
```

Aplikacja sprawdza także `sd-cli` w `PATH`, `/opt/homebrew/bin` i `/usr/local/bin`.

## MCP

Bundle MCP:

```bash
npm run build:mcp
```

Vite tworzy `dist/mcp/server.mjs` bez `better-sqlite3`, Sharp, Electron i innych modułów natywnych. `prepackage` i `premake` budują MCP automatycznie, a Forge kopiuje go do `Contents/Resources/mcp`.

Rejestracja i workflow są opisane w [MCP dla Codexa](codex-mcp.md).

## Pakowanie

```bash
npm run package
npm run make
```

Alternatywny katalog wyjściowy przy weryfikacji:

```bash
TILEMAP_BUILD_OUT_DIR=out-mcp npm run make
```

Forge tworzy:

- rozpakowane `.app` w katalogu wyjściowym;
- ZIP dla macOS w `out/make/zip/...` albo odpowiedniku alternatywnego outDir.

`sharp` i `sharp-libvips` są razem rozpakowywane z ASAR. Samo wypakowanie `.node` bez dylib prowadzi do:

```text
Library not loaded: @rpath/libvips-cpp....dylib
```

## Kontrola paczki Apple Silicon

Ustaw ścieżkę do świeżo zbudowanego `.app`:

```bash
APP="out/Tilemap Generator-darwin-arm64/Tilemap Generator.app"
```

### Podpis i fuses

```bash
codesign --verify --deep --strict --verbose=2 "$APP"

NO_COLOR=1 ./node_modules/.bin/electron-fuses read --app "$APP"
```

Wymagane między innymi:

```text
RunAsNode is Disabled
EnableCookieEncryption is Disabled
EnableNodeOptionsEnvironmentVariable is Disabled
EnableNodeCliInspectArguments is Disabled
EnableEmbeddedAsarIntegrityValidation is Enabled
OnlyLoadAppFromAsar is Enabled
```

### Sharp i libvips

```bash
SHARP_NODE="$APP/Contents/Resources/app.asar.unpacked/node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.3.node"
LIBVIPS="$APP/Contents/Resources/app.asar.unpacked/node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.3.dylib"

file "$SHARP_NODE" "$LIBVIPS"
otool -L "$SHARP_NODE"
otool -l "$SHARP_NODE" | sed -n '/LC_RPATH/,+3p'
```

Wersje nazw plików mogą zmienić się po aktualizacji zależności; w takim przypadku rozwiąż je najpierw przez `find`, zamiast kopiować starą ścieżkę do skryptu destrukcyjnego.

### Smoke aplikacji

```bash
TILEMAP_SMOKE_AUTO_QUIT_MS=3000 \
  "$APP/Contents/MacOS/tilemap-generator"
```

Proces powinien uruchomić main, załadować renderer i zakończyć się samodzielnie w wyznaczonym czasie bez uncaught exception.

### MCP z paczki

Sprawdź obecność:

```bash
test -f "$APP/Contents/Resources/mcp/server.mjs"
```

Następnie wykonaj `initialize` i `tools/list` zwykłym Node 20+; wynik powinien zawierać 11 narzędzi i żadnych logów na stdout poza JSON-RPC.

## Podpis a dystrybucja

Bieżąca konfiguracja używa podpisu ad-hoc (`identity: '-'`) bez hardened runtime i notarization. Może przejść `codesign --verify` i działać lokalnie, ale nie jest gotowym dowodem zgodności z Gatekeeperem po pobraniu ZIP-a na innym Macu.

Publiczna dystrybucja wymaga osobnego procesu:

- Developer ID Application;
- hardened runtime i właściwych entitlements;
- notarization;
- stapling;
- smoke na pliku pobranym z docelowego kanału.

Apple Silicon należy weryfikować na arm64. Intel x64 wymaga osobnego install/build/test na x64; obecność opcjonalnej paczki w lockfile nie dowodzi działającego artefaktu Intel.

## Diagnostyka

Log main:

```text
~/Library/Application Support/Tilemap Generator/logs/main.jsonl
```

Przy problemie zbierz:

- dokładną godzinę;
- projectId, assetId, versionId i jobId;
- provider i status health;
- właściwy fragment `main.jsonl`;
- wpisy generation logs w registry/UI;
- rzeczywiste pliki ze stagingu i asset version directory.

Nie diagnozuj wyłącznie na podstawie ostatniego komunikatu UI. Koreluj log aplikacji, rollout providera i utworzone pliki.
