# Dokumentacja Tilemap Generator

Tilemap Generator to desktopowa aplikacja do tworzenia, weryfikowania, wersjonowania i eksportowania spójnych assetów 2D dla gier izometrycznych oraz top-down.

## Dokumenty

- [Opis produktu i zakres](product-overview.md) — cel aplikacji, główne pojęcia, obsługiwane assety i ograniczenia.
- [Instrukcja użytkownika](user-guide.md) — praca od utworzenia projektu do zatwierdzenia i eksportu.
- [Generowanie i walidacja](generation-validation.md) — providery, kolejka, retry, walidatory i obowiązkowa analiza postaci.
- [Architektura techniczna](architecture.md) — procesy Electron, dane projektu, IPC, kolejka, MCP i bezpieczeństwo.
- [Integracje eksportu](export-integrations.md) — wspólny model eksportu, Unity oraz Phaser 3.
- [Uruchamianie i rozwój na macOS](development-macos.md) — środowisko, testy, pakowanie i diagnostyka modułów natywnych.
- [Wydania macOS i kanały aktualizacji](releasing.md) — podpis, notarization, workflow beta/stable oraz publiczny feed GitHub Pages.
- [MCP dla Codexa](codex-mcp.md) — podłączenie innej lokalnej rozmowy Codexa do uruchomionej aplikacji.

## Źródła prawdy

Dokumentacja opisuje bieżący kontrakt aplikacji, ale źródłami prawdy pozostają:

- `src/shared/domain.ts` dla typów, enumów i walidacji wejścia;
- `src/main/db/project-database.ts` dla trwałych reguł projektu i review;
- `src/main/services/generation-queue.ts` dla generowania, retry i weryfikacji;
- `src/main/services/unity-exporter.ts` oraz `src/main/services/phaser-exporter.ts` dla manifestów eksportu;
- `src/mcp/server.ts` dla publicznego kontraktu MCP;
- testy w `src/test/` dla zachowania regresyjnego.

Jeżeli dokumentacja i działający kontrakt są rozbieżne, najpierw należy potwierdzić zachowanie testem albo rzeczywistym przebiegiem, a potem poprawić dokumentację razem ze zmianą.
