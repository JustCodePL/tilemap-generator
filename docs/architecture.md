# Architektura techniczna

## Stos

- Electron 39;
- React 19 i TanStack Query w rendererze;
- TypeScript i Zod;
- Vite oraz Electron Forge;
- SQLite przez `better-sqlite3` i Drizzle schema;
- Sharp/libvips dla przetwarzania obrazów;
- Codex App Server, ComfyUI API i `stable-diffusion.cpp` jako providery;
- osobny, czysto-JavaScriptowy bundle MCP.

## Procesy i granice

```text
Renderer React
  │ typed window.tilemap API
  ▼
Sandboxed preload
  │ zweryfikowane kanały IPC
  ▼
Electron main
  ├─ ProjectManager / ProjectDatabase
  ├─ GenerationQueue
  ├─ CodexService
  ├─ ComfyService
  ├─ StableDiffusionCppService
  ├─ ExportService
  └─ LocalBridgeServer
         ▲
         │ prywatny Unix socket + token
         │
      MCP STDIO relay ── Codex
```

Renderer ma `contextIsolation=true`, `nodeIntegration=false` i `sandbox=true`. Nie otrzymuje surowego `ipcRenderer`; preload wystawia wyłącznie typowane metody `window.tilemap`.

## Renderer

Główne widoki:

- `project` — ustawienia, styl, referencje i propozycje;
- `generate` — zwykłe assety;
- `characters` — animowane postacie;
- `export` — integracje oraz preview planu;
- `diagnostics` — stan providerów i logi.

TanStack Query przechowuje cache odczytów, ale zdarzenia `projects:changed` i generation events odświeżają dane autorytatywne z main. Nawigacja nie jest źródłem prawdy dla bieżącego projektu.

## Electron main

### ProjectManager

- wybiera dokładny katalog biblioteki;
- tworzy i otwiera `tilemap-project.json` oraz `registry.sqlite`;
- przechowuje listę ostatnich projektów w userData;
- pilnuje jednego aktywnego `ProjectDatabase`;
- rozwiązuje wyłącznie bezpieczne ścieżki `tilemap-asset://` spod otwartego projektu.

### ProjectDatabase

SQLite jest źródłem prawdy dla:

- projektu i ustawień;
- assetów oraz wersji;
- jobów i logów generacji;
- artefaktów;
- pivotów, tagów i review;
- zestawów animacji postaci i analiz ruchu;
- referencji;
- rewizji stylu;
- propozycji zmian ustawień;
- celów i historii eksportu.

Konstruktor wykonuje migracje, tworzy backup przed zmianą schematu i oznacza przerwane joby. Z tego powodu żaden drugi proces nie może otwierać tej samej bazy jako alternatywny writer.

### GenerationQueue

Kolejka:

- atomowo tworzy joby wariantów;
- ogranicza współbieżność;
- serializuje wersje tego samego assetu;
- zarządza anulowaniem i retry;
- publikuje zdarzenia do renderera;
- prowadzi generację, walidację, weryfikację i finalizację;
- blokuje odłączenie bazy, dopóki aktywne zadania nie skończą się albo bezpiecznie nie przerwą przełączenia projektu.

### Provider services

- `CodexService` prowadzi wątki App Servera, capability, registry tools i analizę semantyczną.
- `ComfyService` wykrywa Desktop i lokalne API osobno, sprawdza modele/node-y i wykonuje zarządzany workflow.
- `StableDiffusionCppService` uruchamia `sd-cli` oraz opisuje gotowość modeli.

### ExportService

Rejestruje adaptery integracji i routuje `list`, wybór katalogu, `preview` oraz `run`. Token preview jest związany z projektem, integracją i planem. Każdy adapter sam definiuje politykę celu, manifest i zarządzane pliki.

## Dane na dysku

```text
<project-root>/
├─ tilemap-project.json
├─ registry.sqlite
├─ assets/
│  └─ <asset-id>/<version-id>/
│     ├─ final.png
│     ├─ preview.webp
│     └─ road-variants/road-00.png ... road-15.png
├─ staging/<job-id>/
├─ references/
├─ derived/
└─ backups/
```

Manifest projektu identyfikuje projekt, nazwę, projekcję i nazwę bazy. Assety oraz staging są względne względem rootu, co pozwala przenosić cały katalog jako jedną bibliotekę.

Odrzucone i nieudane wersje nie są automatycznie usuwane. Eksporty zewnętrzne nie stają się częścią katalogu biblioteki.

## IPC

Każdy handler:

- sprawdza nadawcę i origin;
- waliduje payload przez Zod albo ścisły kontrakt domeny;
- korzysta z aktywnego runtime;
- jest śledzony podczas shutdownu, aby baza nie została zamknięta pod trwającą operacją.

Operacje zmieniające projekt uczestniczą w jednej bramce przejścia. Błąd aktywacji nowego projektu próbuje odtworzyć poprzedni runtime i emituje rendererowi faktyczny stan.

## MCP

MCP składa się z dwóch warstw:

1. `dist/mcp/server.mjs` — STDIO JSON-RPC bez modułów natywnych;
2. `LocalBridgeServer` w Electron main — uwierzytelniony Unix socket do żywego runtime.

Relay nie otwiera SQLite. Descriptor i rotowany token znajdują się w chronionym katalogu userData. Każde połączenie dostaje osobną instancję backendu i własny binding projektu.

Publiczny kontrakt nie zwraca root pathów. Obrazy są przekazywane jako zawartość PNG z limitem, a komunikaty statusu redagują lokalne ścieżki. Pełny workflow opisuje [MCP dla Codexa](codex-mcp.md).

## Eksport i transakcje plikowe

Eksporter najpierw buduje preview, a później wykonuje dokładnie ten plan. Zapisy używają stagingu, backupów i rollbacku. Backup plików pozostaje dostępny do czasu atomowego zapisu celu i rekordu eksportu w SQLite.

Cleanup jest manifest-driven:

- usuwa tylko ścieżki wcześniej zadeklarowane jako zarządzane;
- sprawdza właściciela, projectId i dokładny schema version;
- odrzuca ścieżki absolutne, `..`, symlinki i wyjście poza target;
- nie usuwa dowolnych katalogów użytkownika.

## Logowanie

Main zapisuje JSONL:

- macOS: `~/Library/Application Support/Tilemap Generator/logs/main.jsonl`;
- Windows: `%AppData%\Tilemap Generator\logs\main.jsonl`.

Log obejmuje identyfikatory joba, assetu i wersji, błędy App Servera, stderr i awarie protokołu. Prompty nie są zapisywane w logu aplikacji. Szczegółowy prompt wersji pozostaje w registry projektu.

## Bezpieczeństwo

- Renderer jest sandboxed i nie ma Node.
- Nawigacja i otwieranie nowych okien są blokowane poza dozwolonym originem.
- Protokół `tilemap-asset://` rozwiązuje tylko pliki otwartego projektu.
- ComfyUI przyjmuje wyłącznie adresy loopback.
- MCP korzysta z katalogu 0700, sekretów 0600 i nie wystawia portu HTTP.
- Narzędzia MCP zapisujące są oznaczone jako mutujące i mogą wymagać approval.
- Electron ma wyłączone RunAsNode, NODE_OPTIONS, inspect oraz cookie encryption; włączone są ASAR integrity i OnlyLoadAppFromAsar.
- Lokalny build macOS jest podpisany ad-hoc. Nie jest to równoznaczne z Developer ID i notarization.

## Shutdown i macOS lifecycle

Na macOS zamknięcie ostatniego okna ukrywa aplikację, dzięki czemu lokalny bridge MCP może nadal działać. `before-quit`:

1. odrzuca nowe operacje;
2. zatrzymuje bridge;
3. drenuje aktywne handlery;
4. zatrzymuje kolejkę i providery;
5. zamyka bazę;
6. dopiero wtedy kończy proces.

Ponowne `Cmd-Q` podczas cleanupu nie może ominąć tej sekwencji.
