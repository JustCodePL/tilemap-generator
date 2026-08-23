# Opis produktu i zakres

## Cel

Tilemap Generator porządkuje cały cykl życia assetu 2D:

```text
projekt i styl
    ↓
generowanie wariantów
    ↓
walidacja techniczna i semantyczna
    ↓
review użytkownika
    ↓
zatwierdzona wersja
    ↓
eksport przez wybraną integrację
```

Aplikacja ma utrzymać spójność wymiarów, projekcji, kierunków, stylu i metadanych bez przenoszenia tych obowiązków na prompt użytkownika. Projekt jest przenośną biblioteką plików z własnym registry SQLite.

## Główne możliwości

- projekty izometryczne i top-down;
- wersjonowane assety oraz review bez nadpisywania historii;
- równoległe warianty z Codex + imagegen, ComfyUI i `stable-diffusion.cpp`;
- trwała kolejka z anulowaniem, retry, logami i limitem współbieżności;
- referencje i wersjonowane podsumowanie stylu projektu;
- deterministyczne walidatory wymiarów, alfa, geometrii, szwów i dróg;
- osobny workflow postaci z animacją chodu w czterech kierunkach;
- podgląd pojedynczego tile'a oraz powtórzenia o konfigurowalnej szerokości i wysokości;
- eksport zatwierdzonych wersji przez integracje Unity i Phaser 3;
- lokalny MCP dla innej rozmowy Codexa.

## Projekcje

| Projekcja | Komórka | Kierunki postaci i dróg | Uwagi |
| --- | --- | --- | --- |
| `isometric` | 2:1, np. 256×128 px | NW, NE, SE, SW | Obsługuje `elevated_tile` i ściany terenu. |
| `top_down` | 1:1, np. 256×256 px | N, E, S, W | Nie obsługuje `elevated_tile`; grid eksportu jest prostokątny. |

Projekcja jest stałą cechą projektu. Wpływa na wymiary, maski dróg, kierunki postaci, walidację, podgląd oraz format eksportu.

## Kategorie assetów

| Kategoria | Zastosowanie |
| --- | --- |
| `flat_tile` | Pełna, bezszwowa powierzchnia terenu 1×1. |
| `elevated_tile` | Izometryczny teren z wysokością wyrażoną w poziomach. |
| `road_tile` | Jeden materiał źródłowy przekształcany w komplet 16 masek połączeń. |
| `building` | Budynek o rozmiarze i footprintcie względem bazowego tile'a. |
| `character` | Arkusz idle + chód w czterech kierunkach, tworzony w osobnej sekcji. |
| `vegetation` | Roślinność i naturalne elementy sceny. |
| `prop` | Rekwizyty i obiekty dekoracyjne. |
| `effect` | Efekty wizualne. |
| `ui` | Elementy interfejsu gry. |
| `other` | Assety niewpasowujące się w pozostałe kategorie. |

## Najważniejsze pojęcia

- **Katalog biblioteki** — dokładny root projektu; zawiera manifest, registry, assety, staging i backupy.
- **Asset** — logiczny element, np. „Wieża łucznicza”.
- **Wersja** — konkretny wynik generatora albo kolejna iteracja assetu.
- **Provider** — system tworzący wariant: Codex, ComfyUI albo `stable-diffusion.cpp`.
- **Review** — decyzja użytkownika: zatwierdzenie, odrzucenie albo dalsza iteracja.
- **Footprint** — liczba komórek grida zajmowanych przez asset.
- **Pivot** — punkt zakotwiczenia zapisany w zakresie 0–1.
- **Styl projektu** — wersjonowane podsumowanie wspólnych cech wizualnych.
- **Referencja** — jawnie dodany obraz z opisem, dostępny dla kolejnych generacji.
- **Integracja eksportu** — adapter formatu docelowego z własnym katalogiem i manifestem zarządzanych plików.

## Zasady produktu

1. Asset może mieć wiele wersji, ale tylko jedną zatwierdzoną wersję naraz.
2. Wynik generatora nie omija lokalnych walidatorów.
3. Postać nie może trafić do review bez zaliczonej analizy ruchu we wszystkich kierunkach.
4. AI może proponować zmianę ustawień projektu, ale użytkownik zatwierdza ją osobno.
5. Eksport obejmuje tylko zatwierdzone wersje i usuwa wyłącznie pliki wcześniej oznaczone jako zarządzane przez tę samą integrację i projekt.
6. MCP nie zatwierdza wersji automatycznie i nie otwiera bazy projektu poza aplikacją.

## Poza zakresem

Aktualna wersja nie jest:

- edytorem całej mapy;
- usługą chmurową ani systemem współpracy wielu użytkowników;
- zamiennikiem review artystycznego;
- automatycznym systemem publikacji assetów;
- uniwersalnym importerem dowolnego historycznego manifestu.

Unity dostaje narzędzia authoringu i obiekty generowane w edytorze. Phaser dostaje dane runtime oraz manifest File Pack, ale logika gry pozostaje po stronie projektu Phaser.
