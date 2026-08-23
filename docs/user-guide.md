# Instrukcja użytkownika

## 1. Uruchomienie

W repozytorium:

```bash
npm install
npm start
```

Na macOS aplikację można również uruchomić z przygotowanego pakietu `.app`. Ekran **Diagnostyka** pokazuje stan Codexa, Comfy Desktop/API, profilu ComfyUI, `stable-diffusion.cpp` oraz ścieżkę logu aplikacji.

## 2. Utworzenie projektu

1. Wybierz **Nowy projekt**.
2. Wskaż pusty katalog biblioteki. Wybrany katalog staje się dokładnym rootem projektu.
3. Podaj nazwę i opcjonalny brief artystyczny.
4. Wybierz projekcję:
   - izometryczna — komórka 2:1;
   - top-down — komórka 1:1.
5. Ustaw bazową szerokość tile'a i Pixels Per Unit.

Projekcji nie zmienia się po utworzeniu projektu. Nazwę, brief, tile size, PPU, współbieżność, weryfikację AI i aktywne generatory można edytować później.

## 3. Wybór generatorów

Przy tworzeniu nowego assetu wybierz co najmniej jednego providera:

- **Codex + imagegen**;
- **ComfyUI · Z-Image Turbo**;
- **stable-diffusion.cpp · Z-Image Turbo**.

Wybrany zestaw jest zapamiętywany jako domyślny dla kolejnego nowego assetu w tym projekcie. Każdy provider tworzy osobną wersję tego samego assetu. Niewybrany albo niedostępny provider nie powinien blokować formularza; niedostępny provider wybrany do bieżącej generacji blokuje start do czasu naprawy diagnostyki.

Kolejna iteracja istniejącej wersji zachowuje jej provider, chyba że użytkownik jawnie wybierze inny do tej jednej iteracji.

## 4. Tworzenie zwykłego assetu

1. Otwórz **Studio**.
2. Podaj nazwę assetu.
3. Wybierz kategorię.
4. Opcjonalnie dopisz opis, rozmiar względny, elevation lub footprint — zależnie od kategorii.
5. Wybierz providery.
6. Uruchom generację.

Sama nazwa wystarcza do rozpoczęcia, ale opis powinien określać funkcję obiektu i cechy istotne dla rozgrywki. Nie trzeba powtarzać projekcji, kierunków ani wymiarów z projektu — aplikacja dopina je do kontraktu generacji.

## 5. Postacie

Postacie powstają w osobnej sekcji **Postacie**.

1. Podaj nazwę i opis postaci.
2. Sprawdź projektową liczbę klatek chodu na kierunek, a następnie ustaw rozmiar pojedynczej klatki względem tile'a, footprint oraz FPS. FPS steruje tempem odtwarzania, a nie liczbą klatek.
3. Wybierz providery.
4. Uruchom generację.

Aplikacja wymaga arkusza `(N + 1) × 4`, gdzie `N` to ustawienie projektu:

- 1 kolumna idle oraz od 2 do 16 kolumn chodu (domyślnie 8);
- 4 wiersze: wszystkie kierunki projekcji;
- izometria: NW, NE, SE, SW;
- top-down: N, E, S, W.

Jeśli starsza wersja ma mniej klatek niż bieżący standard projektu, review pokazuje ostrzeżenie z obiema wartościami. Taka wersja nie jest po cichu reinterpretowana; kolejna generacja używa aktualnego ustawienia projektu.

Po walidacji technicznej osobna, obowiązkowa analiza Codexa sprawdza ruch w każdym kierunku. Postać nie pojawi się jako gotowa do zatwierdzenia, dopóki raport nie ma `passed` dla wszystkich czterech kierunków. Ogólne wyłączenie weryfikacji AI nie wyłącza tej bramki.

## 6. Kolejka i retry

Dolny pasek pokazuje trwałe joby, postęp, providera oraz błędy. Dostępne są:

- anulowanie aktywnego joba;
- retry nieudanej wersji;
- ponowna weryfikacja gotowego obrazu bez generowania go od nowa;
- podgląd logów konkretnego assetu.

Retry tworzy nową wersję i zachowuje nieudany przebieg w historii. Dla błędów kontraktu postaci aplikacja może automatycznie wybrać najlepszy kandydat, znormalizować arkusz i ponowić próbę; wynik nadal musi przejść pełną walidację oraz analizę ruchu.

## 7. Review

W review sprawdź:

- rzeczywisty PNG i jego przezroczystość;
- kategorię, wymiary i footprint;
- pivot;
- tagi i metadane providera;
- wynik walidacji AI, jeżeli była włączona;
- dla dróg komplet 16 wariantów;
- dla postaci każdą klatkę, kierunek i raport ruchu.

Możesz:

- zatwierdzić wersję;
- odrzucić ją bez kasowania;
- cofnąć zatwierdzenie lub odrzucenie;
- utworzyć edycję albo wariant z feedbackiem.

Asset ma jedną aktywną zatwierdzoną wersję. Zatwierdzenie innej wersji zastępuje poprzedni wybór, ale nie usuwa historii.

### Podgląd tile obok tile

Dla tile'i przełącz widok na **Tile obok tile** i ustaw niezależnie liczbę kolumn oraz wierszy od 1 do 16. Domyślny widok to 3×3. Zmiana rozmiaru siatki zeruje przesunięcie podglądu, ale zachowuje zoom.

## 8. Styl i referencje

Referencje dodawaj z opisem wskazującym, co ma zostać zachowane: paleta, materiał, proporcje, detal albo język kształtów. Styl projektu jest wersjonowany i może być:

- zaktualizowany ręcznie;
- przebudowany z zatwierdzonych assetów;
- przywrócony do starszej rewizji.

Jeżeli agent uzna, że referencje są sprzeczne z projektem, może utworzyć propozycję zmiany briefu, tile size, PPU albo generatorów. Zmiana zaczyna obowiązywać dopiero po zaakceptowaniu propozycji w UI.

## 9. Eksport

1. Zatwierdź wymagane wersje.
2. Otwórz **Eksport**.
3. Wybierz integrację Unity, Phaser albo Godot.
4. Wskaż dokładny katalog docelowy tej integracji.
5. Przejrzyj plan: pliki nowe, zastępowane, niezmienione i usuwane.
6. Uruchom eksport.

Katalog biblioteki projektu i katalogi eksportu są niezależne. Cel jest zapamiętywany osobno dla każdej integracji.

## 10. MCP

Inna lokalna rozmowa Codexa może odczytać kontekst projektu, styl i referencje, dodać referencję oraz uruchomić generację przez aplikację. Instrukcja: [MCP dla Codexa](codex-mcp.md).

MCP nie podejmuje decyzji review. Po wygenerowaniu wróć do UI, aby zatwierdzić albo odrzucić wynik.

## Typowe problemy

### Codex jest niedostępny

Otwórz **Diagnostyka**, odśwież stan i sprawdź wersję, logowanie, App Server, capability image generation oraz skill `imagegen`.

### Comfy Desktop jest wykryty, ale API jest offline

Sama instalacja aplikacji nie oznacza działającego lokalnego backendu. Utwórz lub uruchom lokalną instancję w Comfy Desktop i upewnij się, że API nasłuchuje na skonfigurowanym loopback, domyślnie `127.0.0.1:8188`.

### `stable-diffusion.cpp` jest niedostępny na macOS

Zarządzany instalator jest przeznaczony dla Windows. Na macOS zbuduj `sd-cli` z backendem Metal i ustaw ścieżki binarium oraz modeli zgodnie z [instrukcją rozwoju na macOS](development-macos.md).

### Wygenerowany asset nie trafia do review

Sprawdź log joba. Aplikacja failuje zamknięcie generacji, jeżeli PNG, wymiary, alfa, geometria, szwy, drogi albo obowiązkowa analiza postaci nie spełniają kontraktu.
