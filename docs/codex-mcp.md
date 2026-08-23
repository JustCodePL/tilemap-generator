# Tilemap Generator MCP dla Codexa

Ten dokument opisuje, jak połączyć nową lokalną rozmowę Codexa z uruchomioną aplikacją Tilemap Generator. Integracja działa przez lokalny serwer MCP i prywatny Unix socket. Codex nie otwiera bazy projektu bezpośrednio; wszystkie odczyty i zmiany przechodzą przez ten sam runtime, którego używa UI aplikacji.

Oficjalna dokumentacja OpenAI dotycząca konfiguracji MCP w Codexie: [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp).

## Najkrótsza ścieżka na skonfigurowanym Macu

1. Uruchom Tilemap Generator.
2. Otwórz w aplikacji projekt, którego ma dotyczyć praca.
3. Otwórz **nową lokalną rozmowę Codexa na tym samym Macu**. Rozmowa webowa lub cloud nie ma dostępu do lokalnego socketu aplikacji.
4. Wklej poniższy prompt:

   ```text
   Użyj MCP tilemap_generator. Najpierw wywołaj list_projects. Jeżeli dokładnie
   jeden projekt ma active=true, przypnij go bez pytania. Jeżeli żaden nie jest
   aktywny i dostępnych jest kilka projektów, pokaż mi ich nazwy i zapytaj,
   który wybrać. Następnie wywołaj get_project_context i traktuj zwrócone
   wymagania projektu, styl, referencje, projekcję i generatory jako
   autorytatywne.

   [Tutaj opisz asset, który chcesz utworzyć, jego styl i oczekiwane użycie.]

   Generuj wyłącznie przez generate_asset. Po zakończeniu pobierz wynik przez
   get_asset, przeanalizuj faktyczny PNG, a dla postaci również ruch we
   wszystkich kierunkach. Nie zatwierdzaj assetu automatycznie.
   ```

5. Po wygenerowaniu przejdź do Tilemap Generator i samodzielnie zatwierdź albo odrzuć wersję.

Konfiguracja MCP jest współdzielona przez ChatGPT desktop, Codex CLI i rozszerzenie IDE działające na tym samym hoście. Po pierwszej rejestracji zwykle wystarczy uruchomić aplikację i rozpocząć nową rozmowę.

## Wymagania

- macOS i lokalny klient Codexa;
- uruchomiona aplikacja Tilemap Generator;
- otwarty albo dostępny projekt Tilemap Generator;
- zbudowany plik `dist/mcp/server.mjs`;
- Node.js 20 lub nowszy do uruchomienia entrypointu MCP;
- wpis `tilemap_generator` w konfiguracji Codexa.

MCP nie wystawia portu HTTP. Aplikacja tworzy prywatny runtime w:

```text
~/Library/Application Support/Tilemap Generator/mcp
```

Token jest rotowany przy starcie aplikacji i nie powinien być kopiowany do promptów, logów ani konfiguracji MCP.

## Sprawdzenie istniejącej rejestracji

Na macOS z aplikacją ChatGPT można użyć dołączonego CLI:

```bash
CODEX=/Applications/ChatGPT.app/Contents/Resources/codex
"$CODEX" mcp get tilemap_generator --json
```

Wynik powinien zawierać `"enabled": true` oraz transport `stdio`. Listę wszystkich skonfigurowanych serwerów pokaże:

```bash
"$CODEX" mcp list
```

W aplikacji ChatGPT status serwera można również sprawdzić w **Settings → MCP servers** albo przez `/mcp` w nowej rozmowie.

## Rejestracja od zera z repozytorium

W katalogu repozytorium wykonaj:

```bash
npm run build:mcp

CODEX=/Applications/ChatGPT.app/Contents/Resources/codex
MCP_NODE=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
MCP_ROOT="$PWD"

"$CODEX" mcp add tilemap_generator -- \
  /usr/bin/env -C "$MCP_ROOT" \
  "$MCP_NODE" "$MCP_ROOT/dist/mcp/server.mjs"

"$CODEX" mcp get tilemap_generator --json
```

Następnie w `~/.codex/config.toml`, w sekcji serwera, ustaw tryb zatwierdzania operacji zapisujących:

```toml
[mcp_servers.tilemap_generator]
default_tools_approval_mode = "writes"
```

Nie zastępuj przy tym istniejących pól `command` i `args`. Tryb `writes` pozwala wykonywać odczyty bez dodatkowego pytania, ale zachowuje potwierdzenie dla aktywacji innego projektu, zmiany stylu, dodania referencji i uruchomienia generacji.

Po rejestracji rozpocznij nową rozmowę albo zrestartuj lokalnego klienta, aby odświeżyć listę narzędzi MCP.

## Obowiązkowy przebieg sesji

Serwer narzuca ten przebieg również przez własne instrukcje MCP:

1. `list_projects` — odczytaj projekty dostępne w aplikacji.
2. `bind_project` — przypnij projekt z ostatniej listy.
   - Jeden projekt z `active=true`: wybierz go bez pytania.
   - Brak aktywnego i jeden dostępny projekt: przypnij go.
   - Brak aktywnego i wiele projektów: pokaż listę użytkownikowi i poczekaj na wybór; dopiero potem użyj `confirmedByUser=true`.
3. `get_project_context` — pobierz autorytatywną projekcję, wymiary, kierunki, kategorie, styl, referencje i konfigurację generatorów.
4. Opcjonalnie odczytaj styl i referencje przez `get_style`, `list_references` oraz `get_reference`.
5. Generuj tylko przez `generate_asset`. Nie uruchamiaj równolegle ImageGen ani innego generatora dla tego samego assetu.
6. Odpytuj `get_generation_status` dla zwróconych identyfikatorów jobów.
7. Po zakończeniu użyj `get_asset` i przeanalizuj rzeczywisty PNG oraz metadane.
8. Dla postaci sprawdź cały arkusz animacji, wszystkie kierunki wymagane przez projekcję i `movementAnalysis`.
9. Nigdy nie zatwierdzaj assetu automatycznie. Review wykonuje użytkownik w aplikacji.

Zmiana stylu lub dodanie referencji unieważnia poprzedni kontekst. Agent powinien wtedy ponownie wywołać `get_project_context` przed generacją.

## Narzędzia

| Narzędzie | Rodzaj | Zastosowanie |
| --- | --- | --- |
| `list_projects` | odczyt | Lista projektów dostępnych przez aplikację. |
| `bind_project` | zapis/stanu | Przypięcie dokładnie jednego projektu do sesji MCP. |
| `get_project_context` | odczyt | Autorytatywne wymagania projektu. |
| `get_style` | odczyt | Aktywny styl i ograniczona historia zmian. |
| `update_style` | zapis | Nowa ręczna rewizja stylu. |
| `list_references` | odczyt | Metadane referencji projektu. |
| `add_reference` | zapis | Skopiowanie jawnie wskazanego lokalnego obrazu do projektu. |
| `get_reference` | odczyt obrazu | PNG konkretnej referencji. |
| `generate_asset` | zapis/koszt | Kolejkowanie generacji w aplikacji. |
| `get_generation_status` | odczyt | Status i zredagowane logi jobów. |
| `get_asset` | odczyt obrazu | PNG i metadane wersji do końcowej analizy. |

## Styl i referencje w nowej rozmowie

Agent może określić kierunek stylu bez trwałej zmiany projektu przez pole `styleDirection` w `generate_asset`. Jeżeli styl ma obowiązywać kolejne assety, powinien najpierw zaproponować jego treść użytkownikowi, a po zgodzie użyć `update_style`.

Referencje już należące do projektu wybiera się przez `referenceIds`. Nowy plik można dodać przez `add_reference`, podając jego bezwzględną ścieżkę i opis. Po dodaniu referencji trzeba ponownie pobrać `get_project_context`.

Przykładowa intencja dla nowego assetu:

```json
{
  "request": {
    "name": "Wieża łucznicza",
    "prompt": "Drewniana wieża obronna na kamiennej podstawie.",
    "mode": "generate",
    "category": "building",
    "relativeWidth": 2,
    "relativeHeight": 2,
    "footprint": { "x": 2, "y": 2 },
    "generatorProviders": ["codex"]
  },
  "referenceIds": [],
  "styleDirection": "Zachowaj czytelne, ręcznie malowane krawędzie i paletę projektu."
}
```

Agent powinien skorygować wartości na podstawie `get_project_context`, a nie kopiować ten przykład bez sprawdzenia projektu.

## Diagnostyka

### Narzędzia `tilemap_generator` nie są widoczne

- sprawdź `codex mcp get tilemap_generator --json`;
- jeśli wpisu nie ma, zbuduj i zarejestruj serwer;
- po zmianie konfiguracji rozpocznij nową rozmowę lub zrestartuj klienta;
- upewnij się, że rozmowa działa lokalnie na tym samym Macu.

### `ENOENT ... Tilemap Generator/mcp/endpoint.json`

Konfiguracja MCP istnieje, ale aplikacja nie uruchomiła bridge'a. Uruchom Tilemap Generator, poczekaj na załadowanie okna i ponów `list_projects`. Nie twórz ręcznie pliku `endpoint.json` ani tokena.

### Brak projektów

Otwórz albo utwórz projekt w Tilemap Generator, następnie ponów `list_projects`. MCP nie otwiera samodzielnie bazy na podstawie ścieżki podanej w promptcie.

### Agent prosi o wybór mimo aktywnego projektu

Poproś go o ponowne `list_projects`. Jeżeli dokładnie jeden wpis ma `active=true`, musi przypiąć właśnie ten projekt bez pytania.

### Projekt zmienił się w trakcie sesji

Binding jest fail-closed. Agent powinien ponownie wykonać `list_projects`, `bind_project` i `get_project_context`; nie może po cichu przełączyć się na inny projekt.

### Usunięcie rejestracji

```bash
CODEX=/Applications/ChatGPT.app/Contents/Resources/codex
"$CODEX" mcp remove tilemap_generator
```

Usunięcie wpisu nie kasuje projektów ani assetów Tilemap Generator.

## Granice bezpieczeństwa

- Aplikacja pozostaje jedynym writerem SQLite i właścicielem kolejki.
- Serwer MCP nie zwraca modelowi tokena, katalogu projektu ani bezwzględnych ścieżek zarządzanych plików.
- Publiczne błędy i logi generacji mają zredagowane lokalne ścieżki.
- Referencję można dodać wyłącznie przez jawnie wskazany plik i narzędzie `add_reference`.
- Narzędzia zapisujące podlegają zatwierdzeniom Codexa.
- Zatwierdzanie lub odrzucanie wersji pozostaje wyłącznie w UI Tilemap Generator.
