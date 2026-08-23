# Generowanie i walidacja assetów

## Providery

### Codex + imagegen

Codex App Server prowadzi generację w katalogu projektu i korzysta ze skilla `imagegen`. Może analizować referencje, utworzyć obraz, opisać pivot i — gdy weryfikacja AI jest włączona — ocenić końcowy wariant. Aplikacja nie wymaga `OPENAI_API_KEY` i nie uruchamia automatycznie fallbacku API.

### ComfyUI

ComfyUI udostępnia lokalny workflow Z-Image Turbo przez loopback API. Dla obrazów wymagających alfa workflow może używać node'ów background removal i BiRefNet. Aplikacja rozdziela stan:

- instalacja Comfy Desktop;
- działające lokalne API;
- wymagane modele i node-y;
- gotowość profilu do konkretnego workflow.

ComfyUI generuje obraz, ale nie zastępuje recenzenta semantycznego Codexa.

### stable-diffusion.cpp

`stable-diffusion.cpp` uruchamia lokalne `sd-cli` bez serwera ComfyUI. Zarządzany instalator i dobór wariantu Q3/Q4/Q6 są dostępne na Windows. Na macOS wymagane jest ręczne binarium z backendem Metal. Joby tego providera są serializowane, aby ograniczyć konkurencję o pamięć GPU.

## Wybór i pamiętanie providerów

Nowy asset przyjmuje od jednego do trzech unikalnych providerów. Aplikacja atomowo:

1. tworzy asset, wersje i joby dla wybranego zestawu;
2. zapisuje wybór jako domyślny dla następnego nowego assetu;
3. dopiero po commicie emituje zdarzenia i uruchamia kolejkę.

Błąd podczas tworzenia któregokolwiek wariantu nie może pozostawić częściowego assetu ani połowy zmienionych preferencji.

Iteracja istniejącego assetu tworzy jedną wersję i dziedziczy provider wersji bazowej, jeżeli nie podano innego. Retry zawsze zachowuje provider konkretnego joba.

## Kolejka

Kolejka jest trwała i przypięta do aktualnie otwartego `ProjectDatabase`.

```text
enqueue
  ↓
queued
  ↓
generating
  ↓
deterministyczna walidacja
  ↓
opcjonalna weryfikacja AI / obowiązkowa analiza postaci
  ↓
needs_review
  ↓
approved albo rejected
```

Inne stany końcowe to `failed`, `cancelled` i `interrupted`. Przy otwieraniu projektu przerwane joby są oznaczane jako `interrupted`, zamiast udawać aktywne procesy.

Limit współbieżności projektu wynosi 1–8. Joby różnych assetów mogą działać równolegle. Wersje tego samego assetu zachowują kolejność.

## Wspólne walidatory

W zależności od kategorii aplikacja sprawdza:

- poprawny PNG i oczekiwany model kanałów;
- dokładne wymiary canvasu;
- wymagany kanał alfa i realną przezroczystość;
- brak chroma-key albo wypalonej szachownicy udającej alfa;
- bounds widocznej zawartości;
- geometrię komórki projekcji;
- szwy przy okresowym powtórzeniu;
- spójność pivotu i footprintu;
- kompletność plików pochodnych.

Walidacja lokalna działa niezależnie od przełącznika weryfikacji AI.

## Flat tile

- Izometria: nieprzezroczysty romb we właściwym canvasie 2:1.
- Top-down: w pełni nieprzezroczysty prostokąt 1:1, łącznie z narożnikami.
- Footprint: 1×1.
- Sprawdzane są kształt, bounds i szwy.

Zatwierdzony teren może otrzymać atlas 47 kanonicznych masek blob. Dla izometrii powstają również ściany; dla top-down plik ścian pozostaje pusty.

## Elevated tile

- Dostępny wyłącznie w projekcji izometrycznej.
- Szerokość równa bazowemu tile'owi.
- Wysokość: `tileHeight × (1 + elevationLevels)`.
- Elevation ma zakres 1–16.

UI ukrywa tę kategorię w projekcie top-down, a baza danych ponownie egzekwuje zakaz.

## Road tile

Generator dostarcza jeden nieprzezroczysty materiał nawierzchni. Aplikacja deterministycznie buduje 16 masek od 0 do 15:

- izolowany fragment;
- cztery zakończenia;
- dwie proste;
- cztery zakręty;
- cztery warianty T;
- skrzyżowanie.

Porty po przeciwnych krawędziach muszą być okresowo zgodne również dla nieparzystych wymiarów top-down. Każdy wariant przechodzi kontrolę wymiarów, alfa, maski oraz oczekiwanych połączeń.

## Building i pozostałe obiekty

Budynki zapisują rozmiar względny oraz footprint. Dla kategorii bez specjalizowanego kontraktu aplikacja nadal sprawdza PNG, oczekiwany canvas i przezroczystość, a opcjonalna weryfikacja AI ocenia perspektywę, spójność stylu i użyteczność w projekcie.

## Postacie

### Kontrakt arkusza

Pojedynczy zestaw ma:

- 4 wiersze kierunków;
- `N + 1` kolumn: idle oraz `N` kolejnych klatek chodu, gdzie projekt ustala `N` w zakresie 2–16 (domyślnie 8);
- stały rozmiar klatki;
- transparentne tło i gutter;
- wspólny punkt kontaktu z podłożem;
- domyślnie 8 FPS, dopuszczalnie 1–24 FPS.

Liczba klatek i FPS są niezależne: `N` określa liczbę różnych faz chodu, a FPS tempo ich odtwarzania. Przykładowo 8 klatek przy 8 FPS daje pętlę trwającą 1 sekundę.

Docelowy rozmiar arkusza:

```text
width  = frameWidth × (N + 1)
height = frameHeight × 4
```

### Normalizacja źródła

Provider może zwrócić standardowy canvas większy niż docelowy. Aplikacja:

1. numerycznie sprawdza kanał alfa i wszystkie `(N + 1) × 4` komórki;
2. odrzuca RGB z wypaloną szachownicą;
3. ocenia wszystkich dostępnych kandydatów, zamiast ślepo wybierać pierwszy;
4. dla użytecznego RGBA przepakowuje każdą komórkę osobno;
5. stosuje wspólną skalę, transparentny padding i bottom-center alignment;
6. zachowuje źródło oraz metadane normalizacji.

Nie używa generatywnego usuwania tła, jeżeli obraz ma już rzeczywistą alfę.

### Walidacja deterministyczna

Sprawdzane są między innymi:

- wszystkie `(N + 1) × 4` niepuste komórki;
- transparentne narożniki i gutter;
- drift baseline'u, centroidu i powierzchni sylwetki;
- niezerowe różnice kolejnych faz chodu;
- ciągłość przejścia końca pętli do początku.

Walidator tworzy board analityczny z sekwencją `idle, W1, …, WN, W1` dla każdego kierunku.

### Obowiązkowa analiza agenta

Osobna tura Codexa działa po walidacji technicznej i przed publikacją wersji. Musi zwrócić dokładnie cztery wyniki we właściwej kolejności, sprawdzając:

- kierunek patrzenia;
- zachowanie tożsamości postaci;
- chód w miejscu bez skoków całej sylwetki;
- naprzemienną pracę kończyn;
- ciągłość pętli.

Brak Codexa, malformed output albo `failed` blokują publikację. Raport nieudanego ruchu jest zapisywany przed retry. `ProjectDatabase` ponownie wymaga kompletnego `passed`, identyfikatora tury i czasu analizy przy finalizacji oraz przy review.

## Weryfikacja AI zwykłych assetów

Przełącznik projektu może wyłączyć semantyczną ocenę po generowaniu. Wtedy wersja po kontrolach lokalnych trafia do ręcznego review jako nieweryfikowana. Użytkownik może później uruchomić samą weryfikację istniejącego PNG.

Wyjątkiem są postacie: obowiązkowej analizy ruchu nie można wyłączyć.

## Propozycje ustawień

Agent może utworzyć propozycję, jeżeli referencje albo oczekiwany wynik wymagają zmiany:

- nazwy lub briefu;
- bazowej szerokości tile'a;
- PPU;
- liczby klatek chodu na kierunek;
- aktywnych generatorów.

Propozycja zawiera stan przed zmianą, proponowane pola, powód i referencje. Nie zmienia projektu przed decyzją użytkownika. Jeżeli propozycja powstała w trakcie generacji, kolejka zatrzymuje publikację fail-closed niezależnie od deklarowanego statusu odpowiedzi agenta.

## Publikacja i cleanup

Pliki źródłowe i finalne są publikowane dopiero po ponownym preflightcie bazy. Błąd kopiowania, thumbnaila albo finalizacji usuwa świeżo utworzony katalog wersji i nie rejestruje częściowych artefaktów.

Staging i historia nieudanych wersji są zachowywane diagnostycznie. Nie należy usuwać ich ręcznie w trakcie aktywnego joba.
