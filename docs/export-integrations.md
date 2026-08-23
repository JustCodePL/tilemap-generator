# Integracje eksportu

## Wspólny model

Ekran eksportu pokazuje dynamiczną listę integracji. Każda integracja definiuje:

- identyfikator i opis;
- politykę katalogu docelowego;
- własny manifest;
- sposób kopiowania zatwierdzonych assetów;
- listę zarządzanych plików;
- plan `create`, `replace`, `unchanged` i `delete`.

Cel jest zapamiętywany osobno dla każdej integracji. Wybrany katalog nie zmienia biblioteki projektu.

## Preview i wykonanie

1. Adapter pobiera tylko zatwierdzone wersje, opcjonalnie ograniczone do wskazanych assetów.
2. Odczytuje istniejący manifest tylko wtedy, gdy ma właściwy schema version, integration id i projectId.
3. Buduje plan nowych, zastępowanych, niezmienionych i usuwanych plików.
4. Zwraca jednorazowy token związany z projektem i integracją.
5. `run` wykonuje plan przez staging oraz backup.
6. Dopiero po sukcesie plików zapisuje cel i rekord eksportu w jednej transakcji bazy.
7. Błąd bazy albo plików uruchamia rollback.

Zmiana zatwierdzeń może dać plan zawierający wyłącznie usunięcia. Dlatego preview pozostaje dostępny również przy zerowej liczbie aktualnie zatwierdzonych assetów, jeżeli integracja ma poprzednio zarządzane pliki.

## Własność i bezpieczeństwo

Eksport nie synchronizuje całego katalogu użytkownika. Może usunąć tylko pliki wymienione w poprzednim manifeście tego samego projektu i integracji.

Adaptery:

- odrzucają obcy, uszkodzony albo przyszły schema version;
- odrzucają ścieżki absolutne, napędy Windows, UNC, `..`, NUL i wyjście poza target;
- nie podążają przez symlinki poza katalog;
- zapisują atomowo przez pliki tymczasowe i rename;
- nie usuwają nieznanych plików ani całych katalogów użytkownika.

## Unity

### Cel

Wskaż dokładny katalog wewnątrz `Assets`, na przykład:

```text
MyGame/Assets/TilemapGenerator
```

Adapter odnajduje nadrzędny `Assets` należący do prawidłowego projektu Unity. Zatwierdzone assety i manifest trafiają do wskazanego targetu. Wspólne narzędzia Unity są instalowane raz w:

```text
Assets/TilemapGeneratorIntegration/
├─ Runtime/
└─ Editor/
```

Dzięki temu zmiana targetu assetów nie tworzy duplikatów klas ani asmdefów.

### Manifest

- nazwa: `tilemap-assets.json`;
- ścisły schema version: 9;
- zawiera projekcję, tile size, PPU, zatwierdzone assety i `managedFiles`;
- postać zawiera ścisły kontrakt arkusza, klipów i zaliczoną analizę ruchu.

Importer nie interpretuje dowolnego nowszego schematu jako zgodnego. Nieprawidłowy manifest blokuje synchronizację fail-closed.

### Teren

Dla każdego zatwierdzonego terenu aplikacja eksportuje:

- bazowy PNG;
- atlas blend 8×6 z 47 maskami blob;
- ściany dla izometrii;
- pusty plik ścian dla top-down.

Unity generuje `BaseTile`, `WallTile`, `BlendRuleTile`, `TerrainDefinition`, wspólny `TerrainBlendSet` oraz prefab `TerrainGrid`. Grid jest Isometric albo Rectangle zgodnie z projektem.

`Terrain Blend Brush` aktualizuje bazę, warstwy blend i ściany jako jedną operację. Priorytet terenu przechowywany w `TerrainDefinition` jest zachowywany przy kolejnych eksportach.

### Drogi

Importer wymaga kompletu 16 wariantów. Tworzy sprite'y, `RoadRuleTile.asset` oraz warstwę `Roads` w prefabie grida. Sąsiedzi są interpretowani zgodnie z projekcją.

### Budynki

Unity generuje `BuildingDefinition`, prefab budynku, `BuildingSet` oraz runtime/brush do rozmieszczania footprintów na gridzie. Logika blokuje kolizje komórek i odtwarza stan po ponownym załadowaniu sceny.

### Postacie

Importer tnie arkusz na 20 stabilnie nazwanych sprite'ów i tworzy:

- cztery klipy idle;
- cztery klipy walk;
- AnimatorController;
- `CharacterDefinition`;
- prefab;
- `DirectionalCharacterAnimator` mapujący wektor na cztery kierunki projekcji.

Controller animuje grafikę; nie przesuwa Transformu postaci. Ruch świata należy do kodu gry.

### Generated cleanup

Importer prowadzi inventory generowanych assetów per target/project. Usuwa stare definicje po cofnięciu zatwierdzenia albo przeniesieniu targetu, ale pomija cleanup, jeżeli manifest pod tą samą ścieżką został właśnie atomowo zastąpiony lub przywrócony. Dzięki temu zwykły re-eksport zachowuje GUID-y i referencje prefabów.

Ręczna odbudowa: `Tools > Tilemap Generator > Rebuild Generated Assets`.

## Phaser 3

### Cel

Wskaż dowolny istniejący katalog udostępniany przez grę, na przykład:

```text
my-game/public/assets/tilemap-generator
```

Adapter traktuje go jako dokładny root. Nie wymaga katalogu o nazwie `Assets` i nie instaluje kodu runtime.

### Pliki

```text
<target>/
├─ tilemap-assets.phaser.json
└─ assets/
   ├─ flat_tile/
   ├─ road_tile/
   ├─ building/
   ├─ character/
   └─ ...
```

Manifest:

- schema version 1;
- engine `phaser3`;
- jest natywnym Phaser File Pack;
- zawiera projekcję, typ grida, tile size, PPU i `managedFiles`;
- zapisuje texture key, URL, loader, wymiary, footprint, pivot i Phaser origin;
- drogi muszą mieć dokładnie 16 unikalnych masek 0–15 o poprawnych wymiarach;
- tereny zawierają atlas, 47 masek i dane ścian;
- postacie zawierają frame config, kierunki i definicje idle/walk.

### Ładowanie File Packa

URL-e plików są względne względem katalogu manifestu. Phaser nie wyznacza automatycznie `path` na podstawie URL-a pobranego JSON-a, dlatego ustaw go przed `addPack`:

```js
const manifestUrl = new URL(
  'assets/tilemap-generator/tilemap-assets.phaser.json',
  window.location.href,
);

const response = await fetch(manifestUrl);
const tilemapPack = await response.json();
tilemapPack['tilemap-generator'].path = new URL('.', response.url).href;

// W preload sceny:
this.load.addPack(tilemapPack, 'tilemap-generator');
```

`path` jest użyte celowo: Phaser dołącza je do URL-i plików podczas `addPack`.

### Runtime

Manifest dostarcza dane, ale aplikacja gry nadal odpowiada za:

- utworzenie mapy i warstw;
- interpretację grid delta;
- wybór maski drogi na podstawie sąsiadów;
- użycie masek blend terenu;
- poruszanie postacią i ustawianie animacji;
- kolizje oraz gameplay.

## Dodanie kolejnej integracji

Nowy adapter implementuje wspólny kontrakt `ExportIntegrationAdapter` i jest rejestrowany w `ExportService`. Powinien mieć:

1. nowy identyfikator w `exportIntegrations`;
2. descriptor i dialog celu;
3. ścisłą walidację targetu;
4. preview z pełnym planem;
5. jednorazowy, project-bound token;
6. manifest ownership i bezpieczny cleanup;
7. atomowy commit/rollback;
8. test routingu, synchronizacji, retargetu, obcego manifestu, ścieżek i błędów bazy.

UI nie powinno zawierać warunków specyficznych dla Unity ani Phaser poza prezentacją descriptorów zwracanych przez backend.
