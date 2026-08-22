# Tilemap Generator

Generator może korzystać równolegle z trzech backendów obrazowych: Codex + `imagegen`, ComfyUI oraz `stable-diffusion.cpp`. Każdy włączony backend tworzy osobną wersję tego samego assetu, dzięki czemu wynik można porównać, zatwierdzić jako preferowany i wyeksportować razem z informacją o modelu i systemie, który go wygenerował.

Desktopowa fabryka assetów izometrycznych i top-down z wersjonowanym review oraz integracjami eksportu. Aplikacja łączy lokalny Codex App Server, skill `imagegen` i opcjonalne lokalne renderery ComfyUI oraz `stable-diffusion.cpp` z przenośnym registry SQLite. Pierwszą dostępną integracją eksportową jest Unity.

## Uruchomienie

Wymagania:

- Windows x64 albo macOS (Apple Silicon lub Intel),
- Node.js 20.19+ (zalecana aktualna wersja LTS),
- aktualny, zalogowany Codex CLI (serwer może odrzucić starszą wersję, gdy zmieni się domyślny model),
- aktywny skill `imagegen` i capability image generation.

```powershell
npm install
npm start
```

Na macOS te same komendy uruchom w Terminalu:

```bash
npm install
npm start
```

Aplikacja automatycznie sprawdza Codexa zainstalowanego razem z ChatGPT w `/Applications/ChatGPT.app`, a także typowe lokalizacje Homebrew. Jeżeli Codex jest w innym miejscu, ustaw pełną ścieżkę przed startem:

```bash
export TILEMAP_CODEX_EXE="/pełna/ścieżka/do/codex"
npm start
```

Najważniejsze komendy:

```powershell
npm run verify    # TypeScript + testy automatyczne
npm run package   # rozpakowana aplikacja dla bieżącego systemu
npm run make      # Windows: Squirrel + ZIP; macOS: ZIP z aplikacją .app
```

`better-sqlite3` jest modułem natywnym. Skrypty przełączają go automatycznie między ABI Node i Electron: `npm test` oraz `npm run export:unity` przygotowują wariant Node, po udanym wykonaniu przywracają wariant Electron, a `npm start` zawsze upewnia się, że wariant deweloperski jest gotowy. Przed uruchomieniem tych skryptów zatrzymaj działające `npm start`, ponieważ Windows blokuje załadowany plik `.node`.

Artefakty dystrybucyjne powstają w `out/make/`.

## Przepływ pracy

1. Utwórz przenośny projekt i wskaż jego pusty **katalog biblioteki**. Wybrany katalog staje się dokładnym katalogiem projektu: aplikacja zapisuje w nim registry, historię i wszystkie wersje assetów. Następnie wybierz projekcję oraz ustaw bazową szerokość kafla, brief i PPU. Projekt izometryczny używa proporcji 2:1, więc dla szerokości 256 px wysokość wynosi 128 px. Projekt top-down używa kwadratowych komórek 1:1, więc ten sam kafel ma 256×256 px. Projekcja jest stałą cechą projektu; pozostałe ustawienia można później edytować na stronie projektu.
2. Podaj nazwę pojedynczego assetu, wybierz jego typ i opcjonalnie doprecyzuj go opisem. Sama nazwa wystarcza do uruchomienia generacji. Job trafia do trwałej kolejki i uruchamia `$imagegen` przez lokalny `codex app-server`. W ustawieniach projektu można wybrać od 1 do 8 jednoczesnych zadań; domyślny limit wynosi 1. Zadania różnych assetów mogą działać równolegle, natomiast kolejne wersje tego samego assetu zachowują kolejność. Można też wyłączyć weryfikację AI po generowaniu — Codex wtedy nie otwiera finalnego obrazu do oceny ani nie wykonuje automatycznej korekty. Gotowa wersja zachowuje stan nieweryfikowany i pokazuje w nagłówku akcję **Weryfikacja**, która pozwala później uruchomić samą ocenę istniejącego obrazu, bez ponownego generowania. Lokalne, deterministyczne kontrole formatu PNG, wymiarów, geometrii, szwów i połączeń pozostają aktywne.
   - `Flat tile` oznacza pełną, bezszwową powierzchnię terenu: romb dla izometrii albo nieprzezroczysty kwadrat dla top-down. Canvas jest równy bazowemu kaflowi projektu.
   - `Elevated tile` jest dostępny tylko w projekcie izometrycznym i dodaje wysokość wyrażoną w poziomach. Poziom `N` daje canvas o wysokości `bazowa wysokość × (1 + N)`; dla kafla 256×128 px i poziomu 2 wynik ma 256×384 px.
   - `Road tile` jest kompletnym zestawem transparentnych nakładek 1×1 tworzonym w jednym jobie. Imagegen przygotowuje tylko jedną nieprzezroczystą, pełnokadrową próbkę materiału nawierzchni. Aplikacja buduje z niej deterministycznie wszystkie 16 geometrii, nakłada alfę i identyczne porty połączeń oraz tworzy izolowany fragment, cztery zakończenia, dwie proste, cztery zakręty, cztery warianty T i skrzyżowanie. Kierunki to NW/NE/SE/SW dla izometrii i N/E/S/W dla top-down. Każdy kafel jest walidowany osobno, a review pokazuje cały zestaw jako siatkę 4×4. Zielone/różowe chroma-key i źródła z przezroczystym tłem są odrzucane przed utworzeniem zestawu.
   - `Building` ma relatywną szerokość i wysokość względem bazowego kafla. Domyślne `1×2` daje canvas 256×256 px przy bazie izometrycznej 256×128 albo 256×512 px przy bazie top-down 256×256.
   - `Character` działa tak samo, z domyślnym rozmiarem `0,5×1,5`: odpowiednio 128×192 px albo 128×384 px dla tych samych baz.
   - Typ i parametry rozmiaru są zapisywane w każdej wersji. Kolejna iteracja może je zmienić bez modyfikowania starszych wersji.
   Jeśli referencje są sprzeczne z konfiguracją projektu, agent może zapisać propozycję zmiany briefu, bazowej szerokości kafla lub PPU. Projekt zmienia się dopiero po jej zatwierdzeniu w aplikacji.
3. Po przygotowaniu finalnego PNG agent wyznacza proponowany pivot na podstawie rzeczywistego obrazu. Sprawdź PNG, footprint, pivot, typ, parametry rozmiaru i tagi; pivot możesz nadpisać przed zatwierdzeniem.
4. Zatwierdź, odrzuć bez kasowania lub utwórz edycję/nowy wariant. Asset może mieć tylko jedną zatwierdzoną wersję; zatwierdzenie można cofnąć, aby wybrać inną.
5. Po zatwierdzeniu Codex aktualizuje wersjonowane podsumowanie stylu.
6. Otwórz **Eksport**, wybierz integrację i wskaż dokładny katalog docelowy. Katalog biblioteki pozostaje niezależny od miejsc eksportu, a każda integracja zapamiętuje swój cel osobno. Eksport synchronizuje zatwierdzone wersje z wybranym celem; po cofnięciu ostatniego zatwierdzenia pusty plan assetów może usunąć wcześniej zarządzane pliki. Dla Unity wybierz miejsce wewnątrz `Assets`, na przykład `Assets/TilemapGenerator`; zestaw drogi trafia do własnego podkatalogu jako `road-00.png`…`road-15.png`, a manifest zawiera maskę i kierunki każdego pliku. Narzędzia Unity są instalowane raz, niezależnie od celu, w `Assets/TilemapGeneratorIntegration`. Unity tworzy z wariantów drogi jeden `RoadRuleTile.asset`, który dobiera wariant automatycznie podczas malowania. Każdy zatwierdzony `flat_tile` i `elevated_tile` dostaje też atlas blendingu oraz gotowe assety auto-tile w Unity.

## Integracja Unity: terrain blending i auto-tile

Eksport terenu nie generuje kombinacji parami. Dla każdego zatwierdzonego terenu aplikacja tworzy jeden atlas `--blend.png` w układzie 8×6 z kanonicznymi 47 maskami blob oraz osobny `--walls.png`. Koszt rośnie liniowo z liczbą terenów. Atlas respektuje kształt komórki projektu: romb dla izometrii i prostokąt dla top-down. W projekcie top-down plik ścian jest pusty, ponieważ ta projekcja nie obsługuje elevated tile.

Po imporcie Unity automatycznie tworzy:

- `BaseTile.asset`, `WallTile.asset`, `BlendRuleTile.asset` i `TerrainDefinition.asset` dla każdego terenu,
- `TerrainBlendSet.asset` z zachowywanym między eksportami priorytetem blendowania,
- prefab `<wybrany katalog>/Generated/Prefabs/TerrainGrid.prefab` z siatką Isometric albo Rectangle zgodną z projektem, bazą, warstwami blend i ścianami.

Dla każdej drogi Unity importuje 16 wariantów jako sprite'y i tworzy `<wybrany katalog>/Generated/Roads/<asset-id>/RoadRuleTile.asset`. Reguły sprawdzają czterech sąsiadów zgodnych z projekcją: NW/NE/SE/SW dla izometrii albo N/E/S/W dla top-down. Pojedynczy asset obsługuje odcinki, zakręty, zakończenia, wszystkie cztery warianty T oraz skrzyżowanie. Prefab `TerrainGrid.prefab` dostaje osobną Tilemapę `Roads`; przeciągnij `RoadRuleTile.asset` do Tile Palette i maluj nim na tej warstwie.

`TerrainBlendMap.Paint(cell, terrain)` rozkłada pojedynczy wybór terenu na wszystkie wymagane Tilemapy. Niższy teren trafia pod wyższy tylko na komórkach bezpośredniego styku, więc przejście łąka–woda nie wprowadza pośredniej pustyni. Domyślna kolejność tagów to woda/rzeka, piasek/pustynia, trawa/łąka. Priorytet można zmienić w `TerrainDefinition`, a kolejny eksport go zachowa. Ręczną odbudowę uruchamia menu `Tools > Tilemap Generator > Rebuild Generated Assets`.

Aby malować bez kodu, przeciągnij `<wybrany katalog>/Generated/Prefabs/TerrainGrid.prefab` do sceny, otwórz `Window > 2D > Tile Palette`, wybierz `Terrain Blend Brush`, a jako `Active Target` ustaw główny obiekt `Terrain Grid`. Pick wygenerowanego `BaseTile`, `WallTile` lub kafla już pomalowanego w scenie wybiera odpowiadający mu teren; pędzel nie powiela jego nazwy, typu ani priorytetu w inspektorze. Paint, Erase, Box i Flood Fill aktualizują razem bazę, warstwy blend oraz ściany. Nie trzeba ręcznie przełączać Tilemap.

## Budynki na Gridzie w Unity

Każdy zatwierdzony asset typu `Building` jest importowany jako Sprite z projektowym PPU i zatwierdzonym pivotem. Unity automatycznie tworzy dla niego `BuildingDefinition.asset` oraz prefab `Building.prefab` pod `<wybrany katalog>/Generated/Buildings/<asset-id>/`. Wspólny `TerrainGrid.prefab` zawiera komponent `BuildingMap`, katalog `Buildings` na instancje oraz `BuildingSet.asset` z listą dostępnych typów. Prefaby budynków są renderowane nad terenem i drogami.

Aby stawiać budynki:

1. Przeciągnij `<wybrany katalog>/Generated/Prefabs/TerrainGrid.prefab` do sceny. Ten sam prefab obsługuje teren i budynki.
2. Otwórz `Window > 2D > Tile Palette`, wybierz wygenerowaną paletę `Buildings`, następnie `Building Placement Brush`, a jako `Active Target` ustaw główny obiekt `Terrain Grid`.
3. Kliknij miniaturę budynku w górnej części Tile Palette. Pędzel nie ma osobnego dropdownu ani powtórzonego podglądu assetu; typ wynika z zaznaczonego kafla albo narzędzia Pick użytego w scenie. Pod kursorem pojawi się półprzezroczysty prefab i cały footprint: zielony oznacza wolne komórki, czerwony kolizję.
4. `Paint` tworzy instancję prefabu i zapisuje jej `originCell`; pivot sprite'a trafia dokładnie w środek tej komórki. Footprint zajmuje kolejne komórki w dodatnich osiach X i Y Gridu.
5. `Erase` usuwa cały budynek po kliknięciu dowolnej zajętej komórki. `Pick` wybiera typ klikniętego budynku.

Położenie świata jest zawsze przeliczane przez `Grid.GetCellCenterWorld(originCell)` na Gridzie zgodnym z projekcją projektu. `Szerokość/wysokość canvasa` określa rozmiar PNG względem tile, a `Footprint (komórki)` liczbę logicznie zajętych pól — wysoki budynek może więc mieć canvas 1×3 i footprint 1×1. Ponowny eksport aktualizuje wygenerowaną definicję i prefab; ręczną odbudowę można uruchomić z `Tools > Tilemap Generator > Rebuild Generated Assets`.

Eksport można też uruchomić bez UI (przy wyłączonym `npm start`):

```powershell
npm run export:unity -- "C:\ścieżka\do\TileMapGenerator" "C:\ścieżka\do\projektu Unity\Assets\TilemapGenerator"
```

```bash
npm run export:unity -- "/ścieżka/do/TileMapGenerator" "/ścieżka/do/projektu Unity/Assets/TilemapGenerator"
```

Same atlasy blendu istniejącego eksportu można przebudować bez otwierania bazy projektu i bez wyłączania aplikacji:

```powershell
npm run rebuild:terrain-blends -- "C:\ścieżka\do\projektu Unity\Assets\TilemapGenerator"
```

```bash
npm run rebuild:terrain-blends -- "/ścieżka/do/projektu Unity/Assets/TilemapGenerator"
```

## ComfyUI: auto-detekcja i warianty

Aplikacja automatycznie sprawdza lokalne API `http://127.0.0.1:8188`, instalację Comfy Desktop, wymagane node-y oraz modele. Inny lokalny port można wskazać przed startem aplikacji:

```powershell
$env:TILEMAP_COMFY_URL='http://127.0.0.1:8190'
npm start
```

Na macOS uruchom ComfyUI osobno, a port podaj składnią powłoki:

```bash
export TILEMAP_COMFY_URL='http://127.0.0.1:8190'
npm start
```

Ze względów bezpieczeństwa akceptowane są wyłącznie adresy loopback (`127.0.0.1`, `localhost` i `::1`). Pierwszy zarządzany profil to **Z-Image Turbo**. Współpracuje z bieżącym szablonem Comfy Desktop i do generacji nieprzezroczystych kafli top-down oraz materiałów dróg wymaga:

```text
models/diffusion_models/z_image_turbo_bf16.safetensors
models/text_encoders/qwen_3_4b.safetensors
models/vae/ae.safetensors
```

Assety wymagające kanału alpha używają dodatkowo node'ów usuwania tła oraz modelu:

```text
models/background_removal/birefnet.safetensors
```

Na stronie projektu można niezależnie włączać i wyłączać `Codex + imagegen`, `ComfyUI · Z-Image Turbo` oraz `stable-diffusion.cpp · Z-Image Turbo`; co najmniej jeden generator musi pozostać aktywny. Każdy aktywny renderer zapisuje osobną wersję pod tym samym assetem. Ekran review i lista wersji pokazują badge `system · model`. Registry przechowuje także identyfikator przebiegu, hash zarządzanego workflow oraz metadane, m.in. seed, sampler, scheduler, kroki i CFG. Manifest eksportu Unity ma schemat v8, jawną listę plików zarządzanych, pole `generatedBy` oraz projekcję projektu.

Codex może odczytać stan przez `registry.get_generation_settings` i zaproponować zmianę generatorów przez `registry.propose_project_settings`. Tak jak pozostałe zmiany projektu, propozycja zaczyna obowiązywać dopiero po zatwierdzeniu w UI.

ComfyUI odpowiada za generację i workflow usuwania tła, ale nie jest traktowane jako niezależny recenzent semantyczny. Każdy jego wynik przechodzi te same lokalne, deterministyczne walidatory co wynik Codexa: poprawność PNG i kanału alpha, wymagane wymiary, geometrię tile, test szwów 3×3 oraz komplet i porty 16 wariantów drogi. Gdy weryfikacja AI jest włączona i Codex jest gotowy, Codex może dodatkowo ocenić gotowy wariant ComfyUI. Bez Codexa asset nadal może przejść kontrole techniczne i trafić do ręcznego review.

## stable-diffusion.cpp: instalator i wybór modelu

Trzeci renderer uruchamia bezpośrednio `sd-cli.exe` na Windows albo ręcznie zainstalowany `sd-cli` na macOS, bez serwera ComfyUI. Zarządzany instalator jest dostępny wyłącznie na Windows i:

- wykrywa kartę NVIDIA i jej VRAM,
- rekomenduje profil modelu,
- pobiera najnowszy oficjalny pakiet Windows Vulkan z [wydań stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp/releases),
- pobiera wybrane, przypięte rewizją pliki z Hugging Face,
- wznawia przerwane pobieranie i przed instalacją sprawdza rozmiar oraz SHA-256 każdego pliku,
- pozwala anulować pobieranie i później je wznowić,
- zachowuje wspólny enkoder oraz VAE między profilami i wykorzystuje istniejący VAE/BF16 z ComfyUI bez duplikowania plików.

Instalacja na Windows zaczyna się dopiero po kliknięciu przycisku. Zarządzane pliki trafiają do `%LOCALAPPDATA%\Tilemap Generator\stable-diffusion.cpp`. Dostępne profile:

| Profil | Zastosowanie |
| --- | --- |
| `Q3_K` | oszczędny wariant dla kart około 4 GB VRAM |
| `Q4_K` | rekomendowany balans jakości i szybkości dla 6–8 GB VRAM |
| `Q6_K` | większy wariant jakościowy, najlepiej od 10 GB VRAM |
| `BF16 (ComfyUI)` | oryginalne duże pliki; bez pobierania, jeśli ComfyUI już je ma |

Dla wykrytej w tej chwili karty GTX 1660 6 GB aplikacja rekomenduje `Z-Image Turbo Q4_K` wraz z `Qwen3-4B-Instruct-2507-Q4_K_M`. VAE `ae.safetensors` jest współdzielony z istniejącą instalacją ComfyUI, dlatego nie jest pobierany ponownie.

Ręczna instalacja nadal jest obsługiwana. Aplikacja szuka `sd-cli.exe` w `tools/stable-diffusion.cpp/sd-cli.exe`, `tools/stable-diffusion.cpp/bin/Release/sd-cli.exe`, zarządzanym katalogu instalatora, `%LOCALAPPDATA%\stable-diffusion.cpp\sd-cli.exe` oraz w `PATH`. Można też podać go jawnie:

```powershell
$env:TILEMAP_SD_CPP_EXE='C:\AI\stable-diffusion.cpp\sd-cli.exe'
npm start
```

Na macOS aplikacja nie pobiera pakietu Windows. Zbuduj `stable-diffusion.cpp` ręcznie z backendem Metal według [oficjalnej instrukcji](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/build.md), a następnie wskaż binarium i modele. Przykład po zbudowaniu `sd-cli`:

```bash
export TILEMAP_SD_CPP_EXE="/ścieżka/do/stable-diffusion.cpp/build/bin/sd-cli"
export TILEMAP_SD_CPP_MODEL="/ścieżka/do/z_image_turbo-Q4_K.gguf"
export TILEMAP_SD_CPP_LLM="/ścieżka/do/Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
export TILEMAP_SD_CPP_VAE="/ścieżka/do/ae.safetensors"
npm start
```

Bez tych zmiennych `stable-diffusion.cpp` pozostaje opcjonalnie niedostępny; podstawowe generatory Codex i ComfyUI nadal działają. Wykrywane są również `sd-cli` z `PATH`, `/opt/homebrew/bin` i `/usr/local/bin`.

Profil BF16 używa tych samych plików Z-Image Turbo, które instaluje Comfy Desktop:

```text
%LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Shared\models\diffusion_models\z_image_turbo_bf16.safetensors
%LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Shared\models\text_encoders\qwen_3_4b.safetensors
%LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Shared\models\vae\ae.safetensors
```

Alternatywne lokalizacje można ustawić przez `TILEMAP_SD_CPP_MODEL`, `TILEMAP_SD_CPP_LLM` i `TILEMAP_SD_CPP_VAE`. Parametry CLI profilu odpowiadają zaleceniom Z-Image Turbo: 8 kroków, CFG 1, Euler, flash attention oraz offload modelu i VAE do CPU. Prace tego renderera są serializowane, żeby warianty nie próbowały jednocześnie zająć całej pamięci GPU.

`stable-diffusion.cpp` nie zapewnia w tym profilu natywnego usuwania tła. Dla zwykłych assetów aplikacja prosi o jednolite tło magenta i usuwa wyłącznie obszar połączony z krawędzią canvasu; wynik nadal przechodzi wspólne walidatory alpha i geometrii. Droga pozostaje pełnokadrowym, nieprzezroczystym materiałem, z którego aplikacja buduje 16 wariantów. Opcjonalna weryfikacja semantyczna przez Codex działa tak samo jak dla ComfyUI.

## Dane projektu

Każdy projekt jest samodzielnym katalogiem wybranym jako katalog biblioteki. Aplikacja nie dopisuje do niego automatycznie nazwy projektu ani dodatkowego podkatalogu:

```text
tilemap-project.json
registry.sqlite
assets/<asset-id>/<version-id>/final.png
assets/<asset-id>/<version-id>/preview.webp
assets/<asset-id>/<version-id>/road-variants/road-00.png ... road-15.png
staging/<job-id>/
backups/
```

Odrzucone wersje i artefakty nie są automatycznie usuwane. Migracja istniejącej bazy tworzy kopię w `backups/` przed zmianą schematu.

Nieudana generacja zachowuje pełny komunikat App Servera w `registry.sqlite`. Można ją ponowić z ekranu wersji albo z dolnego paska kolejki; retry tworzy nową wersję i nie usuwa nieudanego przebiegu.

## Logi

Główny proces zapisuje log JSONL w `%AppData%\Tilemap Generator\logs\main.jsonl` na Windows oraz `~/Library/Application Support/Tilemap Generator/logs/main.jsonl` na macOS. Ścieżka jest również widoczna na ekranie Diagnostyka. Log obejmuje błędy turnów, stderr i awarie protokołu App Servera oraz identyfikatory joba, assetu i wersji — bez zapisywania promptów.

## Bezpieczeństwo i Codex

- Renderer nie ma dostępu do Node ani surowego IPC.
- Wszystkie payloady są walidowane przez Zod, a obrazy są serwowane tylko spod katalogu otwartego projektu.
- Wątki Codexa działają w `workspace-write`, z katalogiem projektu jako jedynym workspace root i bez automatycznych zgód.
- Dynamiczne toole `registry.list_tags`, `registry.search_assets` i `registry.get_asset` są read-only.
- Fallback CLI/API obrazu nie jest uruchamiany automatycznie i aplikacja nie prosi o `OPENAI_API_KEY`.
- Codex App Server i dynamic tools są interfejsami eksperymentalnymi; ekran diagnostyki blokuje generację przy niezgodnej instalacji.

Opcjonalny live smoke test nie generuje obrazu ani nie zużywa limitu, lecz sprawdza konto, App Server, capability i skill:

```powershell
$env:TILEMAP_LIVE_CODEX='1'
npx vitest run src/test/live-codex.test.ts
```

```bash
TILEMAP_LIVE_CODEX=1 npx vitest run src/test/live-codex.test.ts
```

## Zakres v1

V1 nie zawiera własnego edytora całej mapy, chmury ani współpracy wielu użytkowników. Eksport terenu zawiera auto-tile, a eksport budynków prefabowy workflow rozmieszczania na Gridzie w edytorze Unity. Eksport zachowuje istniejące pliki `.meta` eksportowanych PNG.
