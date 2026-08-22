import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectDatabase, normalizeTag } from '../main/db/project-database';
import { handleRegistryTool } from '../main/codex/registry-tools';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('ProjectDatabase', () => {
  it('przechowuje odrzucone wersje i zatwierdza kolejną bez kasowania historii', async () => {
    const root = temporaryProjectRoot();
    const database = ProjectDatabase.create(root, {
      name: 'Kamienny świat', artBrief: 'Miękkie krawędzie', tileWidthPx: 256,
    });
    const firstJob = database.enqueueGeneration({
      name: 'Droga', prompt: 'Kamienna droga z mchem', mode: 'generate', category: 'flat_tile', footprint: { x: 1, y: 1 },
    });
    database.addGenerationLog(firstJob.id, 'generation', 'info', 1, 'Generowanie');
    database.addArtifact(firstJob.id, 'candidate-attempt-1', 'staging/job/attempt-1/final.png', 'image/png');
    const failedVerification = database.addGenerationLog(firstJob.id, 'verification', 'warning', 1, 'Wykryto szczeliny');
    expect(failedVerification.previewUrl).toContain('tilemap-asset://project/staging/job/attempt-1/final.png');
    expect(database.listGenerationLogs(firstJob.assetId).map((entry) => entry.stage)).toEqual(['generation', 'verification']);
    expect(database.listGenerationLogs(firstJob.assetId)[1].previewUrl).toBe(failedVerification.previewUrl);
    database.updateJob(firstJob.id, 'generating', 'test');
    const firstImage = await writeTransparentPng(root, 'first.png');
    database.finalizeGeneration(firstJob.id, {
      finalPath: database.relative(firstImage), width: 64, height: 64,
      category: 'flat_tile', tags: ['Kamień', 'Zielony mech'], pivot: { x: 0.45, y: 0.55 }, description: 'Droga',
    });
    expect(database.getAsset(firstJob.assetId)?.versions[0].pivot).toEqual({ x: 0.45, y: 0.55 });
    database.reviewVersion({
      versionId: firstJob.versionId, decision: 'rejected', tags: ['kamień'],
      rejectionReason: 'Za ciemny', footprint: { x: 1, y: 1 }, pivot: { x: 0.5, y: 0.5 },
    });
    const restored = database.undoRejection(firstJob.versionId);
    expect(restored.versions.find((version) => version.id === firstJob.versionId)).toMatchObject({
      status: 'needs_review', rejectionReason: '', finalPath: database.relative(firstImage),
    });
    database.reviewVersion({
      versionId: firstJob.versionId, decision: 'rejected', tags: ['kamień'],
      rejectionReason: 'Nadal za ciemny', footprint: { x: 1, y: 1 }, pivot: { x: 0.5, y: 0.5 },
    });
    expect(database.listGenerationLogs(firstJob.assetId)
      .filter((entry) => entry.stage === 'review').map((entry) => entry.message)).toEqual([
      'Odrzucono wersję. Powód: Za ciemny.',
      'Cofnięto odrzucenie. Wersja ponownie oczekuje na review.',
      'Odrzucono wersję. Powód: Nadal za ciemny.',
    ]);

    const secondJob = database.enqueueGeneration({
      assetId: firstJob.assetId, parentVersionId: firstJob.versionId, name: 'Droga',
      prompt: 'Kamienna droga z mchem', feedback: 'Jaśniejsza', mode: 'edit', category: 'flat_tile',
      footprint: { x: 1, y: 1 },
    });
    const secondImage = await writeTransparentPng(root, 'second.png');
    database.finalizeGeneration(secondJob.id, {
      finalPath: database.relative(secondImage), width: 64, height: 64,
      category: 'flat_tile', tags: ['Kamień', 'Mech'], pivot: { x: 0.5, y: 0.5 }, description: 'Jaśniejsza droga',
    });
    database.reviewVersion({
      versionId: secondJob.versionId, decision: 'approved', tags: ['Kamień', 'Mech'],
      footprint: { x: 1, y: 1 }, pivot: { x: 0.5, y: 0.5 },
    });

    const asset = database.getAsset(firstJob.assetId)!;
    expect(asset.versions).toHaveLength(2);
    expect(asset.versions.find((version) => version.id === firstJob.versionId)?.status).toBe('rejected');
    expect(asset.currentApprovedVersionId).toBe(secondJob.versionId);
    expect(database.searchAssets({ tags: ['mech'] })).toHaveLength(1);
    expect(database.getProject().styleSummaryStale).toBe(true);
    database.close();
  });

  it('pozwala cofnąć zatwierdzenie i blokuje drugą zatwierdzoną wersję assetu', async () => {
    const root = temporaryProjectRoot();
    const database = ProjectDatabase.create(root, {
      name: 'Jedna wersja', artBrief: '', tileWidthPx: 256,
    });
    const firstJob = database.enqueueGeneration({
      name: 'Droga', prompt: 'Kamienna droga', mode: 'generate', category: 'flat_tile', footprint: { x: 1, y: 1 },
    });
    const firstImage = await writeTransparentPng(root, 'approved-first.png');
    database.finalizeGeneration(firstJob.id, {
      finalPath: database.relative(firstImage), width: 64, height: 64,
      category: 'flat_tile', tags: ['kamień'], pivot: { x: 0.5, y: 0.5 }, description: 'Pierwsza droga',
    });
    database.reviewVersion({
      versionId: firstJob.versionId, decision: 'approved', tags: ['kamień'],
      footprint: { x: 1, y: 1 }, pivot: { x: 0.5, y: 0.5 },
    });

    const secondJob = database.enqueueGeneration({
      assetId: firstJob.assetId, parentVersionId: firstJob.versionId, name: 'Droga',
      prompt: 'Kamienna droga', feedback: 'Jaśniejsza', mode: 'edit', category: 'flat_tile',
      footprint: { x: 1, y: 1 },
    });
    const secondImage = await writeTransparentPng(root, 'approved-second.png');
    database.finalizeGeneration(secondJob.id, {
      finalPath: database.relative(secondImage), width: 64, height: 64,
      category: 'flat_tile', tags: ['kamień'], pivot: { x: 0.5, y: 0.5 }, description: 'Druga droga',
    });

    expect(() => database.reviewVersion({
      versionId: secondJob.versionId, decision: 'approved', tags: ['kamień'],
      footprint: { x: 1, y: 1 }, pivot: { x: 0.5, y: 0.5 },
    })).toThrow(/tylko jedna wersja/);

    const unapproved = database.undoApproval(firstJob.versionId);
    expect(unapproved.currentApprovedVersionId).toBeNull();
    expect(unapproved.versions.find((version) => version.id === firstJob.versionId)?.status).toBe('needs_review');
    expect(database.listGenerationLogs(firstJob.assetId)).toContainEqual(expect.objectContaining({
      versionId: firstJob.versionId,
      message: 'Cofnięto zatwierdzenie. Wersja ponownie oczekuje na review.',
    }));

    database.reviewVersion({
      versionId: secondJob.versionId, decision: 'approved', tags: ['kamień'],
      footprint: { x: 1, y: 1 }, pivot: { x: 0.5, y: 0.5 },
    });
    const asset = database.getAsset(firstJob.assetId)!;
    expect(asset.currentApprovedVersionId).toBe(secondJob.versionId);
    expect(asset.versions.filter((version) => version.status === 'approved').map((version) => version.id))
      .toEqual([secondJob.versionId]);
    expect(() => database.sqlite.prepare("UPDATE asset_versions SET status = 'approved' WHERE id = ?")
      .run(firstJob.versionId)).toThrow(/UNIQUE constraint failed/);
    database.close();
  });

  it('naprawia wielokrotne zatwierdzenie podczas migracji projektu v5', () => {
    const root = temporaryProjectRoot();
    const original = ProjectDatabase.create(root, {
      name: 'Migracja zatwierdzeń', artBrief: '', tileWidthPx: 256,
    });
    const firstJob = original.enqueueGeneration({
      name: 'Droga', prompt: 'Pierwsza droga', mode: 'generate', category: 'flat_tile', footprint: { x: 1, y: 1 },
    });
    const secondJob = original.enqueueGeneration({
      assetId: firstJob.assetId, parentVersionId: firstJob.versionId, name: 'Droga', prompt: 'Druga droga',
      mode: 'variant', category: 'flat_tile', footprint: { x: 1, y: 1 },
    });
    original.sqlite.exec('DROP INDEX idx_asset_versions_one_approved_per_asset;');
    original.sqlite.prepare("UPDATE asset_versions SET status = 'approved' WHERE asset_id = ?").run(firstJob.assetId);
    original.sqlite.prepare('UPDATE assets SET current_approved_version_id = ? WHERE id = ?')
      .run(secondJob.versionId, firstJob.assetId);
    original.sqlite.pragma('user_version = 5');
    original.close();

    const migrated = new ProjectDatabase(root);
    const asset = migrated.getAsset(firstJob.assetId)!;
    expect(asset.currentApprovedVersionId).toBe(secondJob.versionId);
    expect(asset.versions.find((version) => version.id === firstJob.versionId)?.status).toBe('needs_review');
    expect(asset.versions.find((version) => version.id === secondJob.versionId)?.status).toBe('approved');
    expect(readdirSync(path.join(root, 'backups')).some((name) => name.startsWith('registry-v5-'))).toBe(true);
    migrated.close();
  });

  it('blokuje wyjście poza katalog projektu', () => {
    const root = temporaryProjectRoot();
    const database = ProjectDatabase.create(root, {
      name: 'Test', artBrief: '', tileWidthPx: 256,
    });
    expect(() => database.resolveRelative('../secret.png')).toThrow(/poza katalogiem/);
    database.close();
  });

  it('migruje projekt v1 do trwałych logów generacji i tworzy kopię bazy', () => {
    const root = temporaryProjectRoot();
    const original = ProjectDatabase.create(root, {
      name: 'Migracja', artBrief: '', tileWidthPx: 256,
    });
    original.sqlite.exec('DROP TABLE generation_job_logs; PRAGMA user_version = 1;');
    original.close();

    const migrated = new ProjectDatabase(root);
    const job = migrated.enqueueGeneration({
      name: 'Teren', prompt: 'Zielony teren', mode: 'generate', category: 'flat_tile', footprint: { x: 1, y: 1 },
    });
    migrated.addGenerationLog(job.id, 'generation', 'info', 1, 'Działa po migracji');
    expect(migrated.listGenerationLogs(job.assetId)).toHaveLength(1);
    expect(readdirSync(path.join(root, 'backups')).some((name) => name.startsWith('registry-v1-'))).toBe(true);
    migrated.close();
  });

  it('uzupełnia log dla wersji odrzuconej przed dodaniem historii review', () => {
    const root = temporaryProjectRoot();
    const original = ProjectDatabase.create(root, {
      name: 'Stary projekt', artBrief: '', tileWidthPx: 256,
    });
    const job = original.enqueueGeneration({
      name: 'Łąka', prompt: 'Zielona łąka', mode: 'generate', category: 'flat_tile', footprint: { x: 1, y: 1 },
    });
    original.sqlite.prepare(`
      UPDATE asset_versions SET status = 'rejected', rejection_reason = 'Widoczne szwy', updated_at = ? WHERE id = ?
    `).run('2026-08-07T10:00:00.000Z', job.versionId);
    original.close();

    const reopened = new ProjectDatabase(root);
    expect(reopened.listGenerationLogs(job.assetId)).toContainEqual(expect.objectContaining({
      versionId: job.versionId,
      stage: 'review',
      level: 'warning',
      message: 'Odrzucono wersję. Powód: Widoczne szwy.',
    }));
    reopened.close();
  });

  it('migruje logi v2 i zapisuje rozwijalne szczegóły toola', () => {
    const root = temporaryProjectRoot();
    const original = ProjectDatabase.create(root, {
      name: 'Szczegóły logów', artBrief: '', tileWidthPx: 256,
    });
    original.sqlite.exec(`
      DROP TABLE generation_job_logs;
      CREATE TABLE generation_job_logs (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
        stage TEXT NOT NULL, level TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
        message TEXT NOT NULL, created_at TEXT NOT NULL
      );
      PRAGMA user_version = 2;
    `);
    original.close();

    const migrated = new ProjectDatabase(root);
    const job = migrated.enqueueGeneration({
      name: 'Droga', prompt: 'Kamienna droga', mode: 'generate', category: 'flat_tile', footprint: { x: 1, y: 1 },
    });
    migrated.addGenerationLog(job.id, 'generation', 'info', 1, 'Wyszukiwanie', {
      tool: 'registry.search_assets', arguments: { query: 'droga', limit: 5 },
    });
    expect(migrated.listGenerationLogs(job.assetId)[0].details).toEqual({
      tool: 'registry.search_assets', arguments: { query: 'droga', limit: 5 },
    });
    migrated.close();
  });

  it('importuje, opisuje i udostępnia agentowi projektowy obraz referencyjny', async () => {
    const root = temporaryProjectRoot();
    const sourcePath = path.join(path.dirname(root), 'painted-desert.jpg');
    await sharp({ create: { width: 2_400, height: 1_200, channels: 3, background: '#d8a85f' } }).jpeg().toFile(sourcePath);
    const database = ProjectDatabase.create(root, {
      name: 'Referencje', artBrief: '', tileWidthPx: 256,
    });

    const reference = await database.addProjectReference(sourcePath, 'Paleta piasku i miękkie malowane krawędzie');
    expect(reference).toMatchObject({ name: 'painted-desert', description: 'Paleta piasku i miękkie malowane krawędzie', width: 2_048, height: 1_024 });
    expect(reference.imageUrl).toContain('tilemap-asset://project/references/');
    expect(existsSync(database.resolveRelative(reference.relativePath))).toBe(true);

    const updated = database.updateProjectReference(reference.id, 'Ciepła paleta i subtelna faktura piasku');
    expect(updated.description).toBe('Ciepła paleta i subtelna faktura piasku');
    const listed = await handleRegistryTool(database, { namespace: 'registry', tool: 'list_references', arguments: {} }) as { contentItems: Array<{ text: string }> };
    expect(listed.contentItems[0].text).toContain('Ciepła paleta');
    const loaded = await handleRegistryTool(database, { namespace: 'registry', tool: 'get_reference', arguments: { referenceId: reference.id } }) as { contentItems: Array<Record<string, unknown>> };
    expect(loaded.contentItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'inputText' }),
      expect.objectContaining({ type: 'inputImage', imageUrl: expect.stringMatching(/^data:image\/png;base64,/) }),
    ]));

    database.removeProjectReference(reference.id);
    expect(database.listProjectReferences()).toHaveLength(0);
    expect(existsSync(database.resolveRelative(reference.relativePath))).toBe(false);
    expect(existsSync(sourcePath)).toBe(true);
    database.close();
  });

  it('dodaje tabelę referencji podczas migracji projektu v3', () => {
    const root = temporaryProjectRoot();
    const original = ProjectDatabase.create(root, {
      name: 'Migracja referencji', artBrief: '', tileWidthPx: 256,
    });
    original.sqlite.exec('DROP TABLE project_references; PRAGMA user_version = 3;');
    original.close();

    const migrated = new ProjectDatabase(root);
    expect(migrated.listProjectReferences()).toEqual([]);
    expect(readdirSync(path.join(root, 'backups')).some((name) => name.startsWith('registry-v3-'))).toBe(true);
    migrated.close();
  });

  it('pozwala agentowi tylko zaproponować ustawienia i stosuje je po zgodzie użytkownika', async () => {
    const root = temporaryProjectRoot();
    const sourcePath = path.join(path.dirname(root), 'grid-reference.png');
    await sharp({ create: { width: 512, height: 256, channels: 4, background: '#8ba46a' } }).png().toFile(sourcePath);
    const database = ProjectDatabase.create(root, {
      name: 'Korekta siatki', artBrief: 'Małe kafle', tileWidthPx: 256,
    });
    const reference = await database.addProjectReference(sourcePath, 'Referencja przygotowana dla komórki 512×256 px');

    const toolResult = await handleRegistryTool(database, {
      namespace: 'registry',
      tool: 'propose_project_settings',
      arguments: {
        reason: 'Referencja ma geometrię 2:1 przygotowaną dla większej komórki i wymaga korekty siatki.',
        settings: { tileWidthPx: 512, pixelsPerUnit: 512 },
        referenceIds: [reference.id],
      },
    }) as { contentItems: Array<{ text: string }> };

    expect(toolResult.contentItems[0].text).toContain('oczekuje na decyzję użytkownika');
    const proposal = database.listProjectSettingsProposals()[0];
    expect(proposal).toMatchObject({
      status: 'pending',
      before: { artBrief: 'Małe kafle', tileWidthPx: 256, pixelsPerUnit: 256 },
      proposed: { tileWidthPx: 512, pixelsPerUnit: 512 },
      referenceIds: [reference.id],
    });
    expect(database.getProject()).toMatchObject({ tileWidthPx: 256, tileHeightPx: 128, pixelsPerUnit: 256 });

    database.reviewProjectSettingsProposal(proposal.id, 'approved');
    expect(database.getProject()).toMatchObject({
      tileWidthPx: 512, tileHeightPx: 256, pixelsPerUnit: 512, styleSummaryStale: true,
    });
    expect(() => database.reviewProjectSettingsProposal(proposal.id, 'rejected')).toThrow(/już rozpatrzona/);

    const rejected = database.createProjectSettingsProposal({
      reason: 'Brief powinien opisywać paletę widoczną na referencji.',
      settings: { artBrief: 'Ciepła, malowana paleta' },
      referenceIds: [reference.id],
    });
    database.reviewProjectSettingsProposal(rejected.id, 'rejected');
    expect(database.getProject().artBrief).toBe('Małe kafle');
    expect(database.listProjectSettingsProposals().find((item) => item.id === rejected.id)?.status).toBe('rejected');
    database.close();
  });

  it('dodaje tabelę propozycji ustawień podczas migracji projektu v4', () => {
    const root = temporaryProjectRoot();
    const original = ProjectDatabase.create(root, {
      name: 'Migracja propozycji', artBrief: '', tileWidthPx: 256,
    });
    original.sqlite.exec('DROP TABLE project_settings_proposals; PRAGMA user_version = 4;');
    original.close();

    const migrated = new ProjectDatabase(root);
    expect(migrated.listProjectSettingsProposals()).toEqual([]);
    expect(readdirSync(path.join(root, 'backups')).some((name) => name.startsWith('registry-v4-'))).toBe(true);
    migrated.close();
  });

  it('edytuje bazową szerokość projektu i automatycznie utrzymuje proporcję 2:1', () => {
    const root = temporaryProjectRoot();
    const database = ProjectDatabase.create(root, {
      name: 'Stara nazwa', artBrief: '', tileWidthPx: 256,
    });
    expect(database.getProject()).toMatchObject({ maxConcurrentJobs: 1, aiVerificationEnabled: true });

    const updated = database.updateProjectSettings({
      name: 'Wyspy',
      artBrief: 'Malowane bloki terenu',
      tileWidthPx: 512,
      pixelsPerUnit: 512,
      maxConcurrentJobs: 4,
      aiVerificationEnabled: false,
    });

    expect(updated).toMatchObject({
      name: 'Wyspy', tileWidthPx: 512, tileHeightPx: 256, pixelsPerUnit: 512,
      maxConcurrentJobs: 4, aiVerificationEnabled: false,
    });
    expect(JSON.parse(readFileSync(path.join(root, 'tilemap-project.json'), 'utf8'))).toMatchObject({ name: 'Wyspy' });
    database.close();
  });

  it('dodaje domyślny limit równoległości podczas migracji projektu v11', () => {
    const root = temporaryProjectRoot();
    const original = ProjectDatabase.create(root, {
      name: 'Projekt v11', artBrief: '', tileWidthPx: 256,
    });
    original.sqlite.exec('ALTER TABLE projects DROP COLUMN max_concurrent_jobs; PRAGMA user_version = 11;');
    original.close();

    const migrated = new ProjectDatabase(root);
    expect(migrated.getProject().maxConcurrentJobs).toBe(1);
    expect(readdirSync(path.join(root, 'backups')).some((name) => name.startsWith('registry-v11-'))).toBe(true);
    migrated.close();
  });

  it('włącza domyślnie weryfikację AI podczas migracji projektu v12', () => {
    const root = temporaryProjectRoot();
    const original = ProjectDatabase.create(root, {
      name: 'Projekt v12', artBrief: '', tileWidthPx: 256,
    });
    original.sqlite.exec('ALTER TABLE projects DROP COLUMN ai_verification_enabled; PRAGMA user_version = 12;');
    original.close();

    const migrated = new ProjectDatabase(root);
    expect(migrated.getProject().aiVerificationEnabled).toBe(true);
    expect(readdirSync(path.join(root, 'backups')).some((name) => name.startsWith('registry-v12-'))).toBe(true);
    migrated.close();
  });

  it('dodaje stan weryfikacji AI do wersji podczas migracji projektu v13', () => {
    const root = temporaryProjectRoot();
    const original = ProjectDatabase.create(root, {
      name: 'Projekt v13', artBrief: '', tileWidthPx: 256,
    });
    const job = original.enqueueGeneration({
      name: 'Kamień', prompt: '', mode: 'generate', category: 'other', footprint: { x: 1, y: 1 },
    });
    original.sqlite.exec(`
      ALTER TABLE asset_versions DROP COLUMN ai_verification_status;
      ALTER TABLE asset_versions DROP COLUMN ai_verification_message;
      PRAGMA user_version = 13;
    `);
    original.close();

    const migrated = new ProjectDatabase(root);
    expect(migrated.getAsset(job.assetId)?.versions[0]).toMatchObject({
      aiVerificationStatus: 'passed', aiVerificationMessage: '',
    });
    expect(readdirSync(path.join(root, 'backups')).some((name) => name.startsWith('registry-v13-'))).toBe(true);
    migrated.close();
  });

  it('zapisuje relatywny rozmiar budynku osobno dla każdej wersji assetu', () => {
    const root = temporaryProjectRoot();
    const database = ProjectDatabase.create(root, {
      name: 'Rozmiary budynków', artBrief: '', tileWidthPx: 256,
    });
    const firstJob = database.enqueueGeneration({
      name: 'Karczma', prompt: 'Drewniana karczma', category: 'building', mode: 'generate',
      footprint: { x: 1, y: 1 },
    });

    expect(database.getAsset(firstJob.assetId)).toMatchObject({
      relativeWidth: 1,
      relativeHeight: 2,
      versions: [expect.objectContaining({ relativeWidth: 1, relativeHeight: 2 })],
    });

    const secondJob = database.enqueueGeneration({
      assetId: firstJob.assetId,
      parentVersionId: firstJob.versionId,
      name: 'Karczma',
      prompt: 'Drewniana karczma',
      feedback: 'Większy budynek',
      category: 'building',
      mode: 'edit',
      footprint: { x: 2, y: 2 },
      relativeWidth: 2,
      relativeHeight: 3,
    });

    const asset = database.getAsset(firstJob.assetId)!;
    expect(asset).toMatchObject({ relativeWidth: 2, relativeHeight: 3 });
    expect(asset.versions.find((version) => version.id === firstJob.versionId)).toMatchObject({
      relativeWidth: 1,
      relativeHeight: 2,
    });
    expect(asset.versions.find((version) => version.id === secondJob.versionId)).toMatchObject({
      relativeWidth: 2,
      relativeHeight: 3,
    });
    database.close();
  });

  it('migruje projekt v6 do bazowej siatki 2:1 i typu flat tile', () => {
    const root = temporaryProjectRoot();
    const original = ProjectDatabase.create(root, {
      name: 'Projekt v6', artBrief: '', tileWidthPx: 192,
    });
    const job = original.enqueueGeneration({
      name: 'Łąka', prompt: '', category: 'flat_tile', mode: 'generate', footprint: { x: 1, y: 1 },
    });
    original.sqlite.exec(`
      UPDATE projects SET tile_height_px = 100;
      UPDATE assets SET category = 'terrain';
      UPDATE asset_versions SET category = 'terrain';
      ALTER TABLE assets DROP COLUMN elevation_levels;
      ALTER TABLE assets DROP COLUMN relative_width;
      ALTER TABLE assets DROP COLUMN relative_height;
      ALTER TABLE asset_versions DROP COLUMN elevation_levels;
      ALTER TABLE asset_versions DROP COLUMN relative_width;
      ALTER TABLE asset_versions DROP COLUMN relative_height;
      PRAGMA user_version = 6;
    `);
    original.close();

    const migrated = new ProjectDatabase(root);
    expect(migrated.getProject()).toMatchObject({
      tileWidthPx: 192,
      tileHeightPx: 96,
    });
    expect(migrated.getAsset(job.assetId)).toMatchObject({
      category: 'flat_tile', elevationLevels: 0, relativeWidth: 1, relativeHeight: 1,
      versions: [expect.objectContaining({ category: 'flat_tile', elevationLevels: 0 })],
    });
    expect(readdirSync(path.join(root, 'backups')).some((name) => name.startsWith('registry-v6-'))).toBe(true);
    migrated.close();
  });

  it('przenosi dawną geometrię projektu v7 na typ elevated tile', () => {
    const root = temporaryProjectRoot();
    const original = ProjectDatabase.create(root, {
      name: 'Projekt v7', artBrief: '', tileWidthPx: 256,
    });
    const job = original.enqueueGeneration({
      name: 'Wyspa', prompt: '', category: 'flat_tile', mode: 'generate', footprint: { x: 1, y: 1 },
    });
    original.sqlite.exec(`
      ALTER TABLE projects ADD COLUMN terrain_geometry TEXT NOT NULL DEFAULT 'flat';
      UPDATE projects SET terrain_geometry = 'elevated';
      UPDATE assets SET category = 'terrain';
      UPDATE asset_versions SET category = 'terrain';
      ALTER TABLE assets DROP COLUMN elevation_levels;
      ALTER TABLE assets DROP COLUMN relative_width;
      ALTER TABLE assets DROP COLUMN relative_height;
      ALTER TABLE asset_versions DROP COLUMN elevation_levels;
      ALTER TABLE asset_versions DROP COLUMN relative_width;
      ALTER TABLE asset_versions DROP COLUMN relative_height;
      PRAGMA user_version = 7;
    `);
    original.close();

    const migrated = new ProjectDatabase(root);
    expect(migrated.getAsset(job.assetId)).toMatchObject({
      category: 'elevated_tile', elevationLevels: 1,
      versions: [expect.objectContaining({ category: 'elevated_tile', elevationLevels: 1 })],
    });
    migrated.close();
  });
});

it('normalizuje polskie tagi do stabilnych slugów', () => {
  expect(normalizeTag('  Zielony Mech  ')).toBe('zielony-mech');
  expect(normalizeTag('Droga / kamień')).toBe('droga-kamien');
});

it('zapisuje komplet wariantów road tile osobno dla każdej wersji', () => {
  const root = temporaryProjectRoot();
  const database = ProjectDatabase.create(root, {
    name: 'Drogi', artBrief: '', tileWidthPx: 256,
  });
  const firstJob = database.enqueueGeneration({
    name: 'Piaskowa droga', prompt: '', category: 'road_tile',
    mode: 'generate', footprint: { x: 1, y: 1 },
  });
  database.finalizeGeneration(firstJob.id, {
    finalPath: 'assets/road/grid.png', width: 256, height: 128,
    category: 'road_tile', tags: ['droga'], pivot: { x: 0.5, y: 0.5 }, description: 'Droga',
    roadVariants: Array.from({ length: 16 }, (_, connectionMask) => ({
      connectionMask, finalPath: `assets/road/road-${connectionMask.toString().padStart(2, '0')}.png`,
      width: 256, height: 128,
    })),
  });
  expect(database.getAsset(firstJob.assetId)).toMatchObject({
    category: 'road_tile', roadConnections: 15,
    versions: [expect.objectContaining({
      roadConnections: 15, pivot: { x: 0.5, y: 0.5 },
      roadVariants: expect.arrayContaining([
        expect.objectContaining({ connectionMask: 0 }),
        expect.objectContaining({ connectionMask: 7 }),
        expect.objectContaining({ connectionMask: 15 }),
      ]),
    })],
  });

  const secondJob = database.enqueueGeneration({
    assetId: firstJob.assetId, parentVersionId: firstJob.versionId,
    name: 'Piaskowa droga', prompt: '', category: 'road_tile',
    mode: 'variant', footprint: { x: 1, y: 1 },
  });
  database.finalizeGeneration(secondJob.id, {
    finalPath: 'assets/road-v2/grid.png', width: 256, height: 128,
    category: 'road_tile', tags: ['droga'], pivot: { x: 0.5, y: 0.5 }, description: 'Droga v2',
    roadVariants: [{ connectionMask: 15, finalPath: 'assets/road-v2/road-15.png', width: 256, height: 128 }],
  });
  const roadAsset = database.getAsset(firstJob.assetId);
  expect(roadAsset?.roadConnections).toBe(15);
  expect(roadAsset?.versions.find((version) => version.id === firstJob.versionId)?.roadVariants).toHaveLength(16);
  expect(roadAsset?.versions.find((version) => version.id === secondJob.versionId)?.roadVariants).toHaveLength(1);
  expect(() => database.enqueueGeneration({
    name: 'Za duża droga', prompt: '', category: 'road_tile',
    mode: 'generate', footprint: { x: 2, y: 1 },
  })).toThrow(/footprint 1/);
  database.close();
});

it('migruje pojedynczy road tile v10 jako historyczny wariant', () => {
  const root = temporaryProjectRoot();
  const original = ProjectDatabase.create(root, { name: 'Drogi v10', artBrief: '', tileWidthPx: 256 });
  const job = original.enqueueGeneration({
    name: 'Stara droga', prompt: '', category: 'road_tile', mode: 'generate', footprint: { x: 1, y: 1 },
  });
  original.finalizeGeneration(job.id, {
    finalPath: 'assets/old-road.png', width: 256, height: 128,
    category: 'road_tile', tags: ['droga'], pivot: { x: 0.5, y: 0.5 }, description: 'Stara droga',
  });
  original.sqlite.exec(`
    UPDATE assets SET road_connections = 5;
    UPDATE asset_versions SET road_connections = 5;
    DROP TABLE road_variants;
    PRAGMA user_version = 10;
  `);
  original.close();

  const migrated = new ProjectDatabase(root);
  expect(migrated.getAsset(job.assetId)?.versions[0].roadVariants).toEqual([
    expect.objectContaining({ connectionMask: 5, finalPath: 'assets/old-road.png', width: 256, height: 128 }),
  ]);
  migrated.close();
});

it('migruje projekt v9, dodając maskę połączeń drogi', () => {
  const root = temporaryProjectRoot();
  const original = ProjectDatabase.create(root, {
    name: 'Projekt v9', artBrief: '', tileWidthPx: 256,
  });
  const job = original.enqueueGeneration({
    name: 'Łąka', prompt: '', category: 'flat_tile', mode: 'generate', footprint: { x: 1, y: 1 },
  });
  original.sqlite.exec(`
    ALTER TABLE assets DROP COLUMN road_connections;
    ALTER TABLE asset_versions DROP COLUMN road_connections;
    PRAGMA user_version = 9;
  `);
  original.close();

  const migrated = new ProjectDatabase(root);
  expect(migrated.getAsset(job.assetId)).toMatchObject({
    roadConnections: 0,
    versions: [expect.objectContaining({ roadConnections: 0 })],
  });
  expect(readdirSync(path.join(root, 'backups')).some((name) => name.startsWith('registry-v9-'))).toBe(true);
  migrated.close();
});

it('migrates a v14 project and preserves ComfyUI variant provenance', async () => {
  const root = temporaryProjectRoot();
  const original = ProjectDatabase.create(root, {
    name: 'Projekt v14', artBrief: '', tileWidthPx: 256,
  });
  const legacyJob = original.enqueueGeneration({
    name: 'Stary asset', prompt: '', category: 'other', mode: 'generate', footprint: { x: 1, y: 1 },
  });
  original.sqlite.exec(`
    ALTER TABLE projects DROP COLUMN codex_generation_enabled;
    ALTER TABLE projects DROP COLUMN comfyui_enabled;
    ALTER TABLE projects DROP COLUMN comfyui_profile;
    ALTER TABLE projects DROP COLUMN stable_diffusion_cpp_enabled;
    ALTER TABLE asset_versions DROP COLUMN generator_provider;
    ALTER TABLE asset_versions DROP COLUMN generator_model;
    ALTER TABLE asset_versions DROP COLUMN generator_workflow_hash;
    ALTER TABLE asset_versions DROP COLUMN provider_run_id;
    ALTER TABLE asset_versions DROP COLUMN generation_metadata_json;
    ALTER TABLE generation_jobs DROP COLUMN generator_provider;
    PRAGMA user_version = 14;
  `);
  original.close();

  const migrated = new ProjectDatabase(root);
  expect(migrated.getProject()).toMatchObject({
    codexGenerationEnabled: true, comfyUiEnabled: false, comfyUiProfile: 'z_image_turbo',
    stableDiffusionCppEnabled: false,
  });
  expect(migrated.getJob(legacyJob.id)).toMatchObject({ generatorProvider: 'codex' });
  migrated.updateProjectSettings({
    name: 'Projekt v14', artBrief: '', tileWidthPx: 256, pixelsPerUnit: 256,
    maxConcurrentJobs: 1, aiVerificationEnabled: true,
    codexGenerationEnabled: false, comfyUiEnabled: true, comfyUiProfile: 'z_image_turbo',
    stableDiffusionCppEnabled: true,
  });
  const generationSettings = await handleRegistryTool(migrated, {
    namespace: 'registry', tool: 'get_generation_settings', arguments: {},
  }) as { contentItems: Array<{ text: string }> };
  expect(JSON.parse(generationSettings.contentItems[0].text)).toEqual({
    codexGenerationEnabled: false, comfyUiEnabled: true, comfyUiProfile: 'z_image_turbo',
    stableDiffusionCppEnabled: true,
  });
  const comfyJob = migrated.enqueueGeneration({
    name: 'Chata', prompt: 'Drewniana chata', category: 'building', mode: 'generate',
    footprint: { x: 1, y: 1 }, generatorProvider: 'comfyui',
  });
  const image = await writeTransparentPng(root, 'comfy.png');
  migrated.finalizeGeneration(comfyJob.id, {
    finalPath: migrated.relative(image), width: 64, height: 64, category: 'building', tags: ['drewno'],
    pivot: { x: 0.5, y: 0 }, description: 'Chata', generatorProvider: 'comfyui',
    generatorModel: 'z_image_turbo_bf16.safetensors', generatorWorkflowHash: 'workflow-sha256',
    providerRunId: 'prompt-123', generationMetadata: { seed: 42, steps: 8 },
  });

  expect(migrated.getAsset(comfyJob.assetId)?.versions[0]).toMatchObject({
    generatorProvider: 'comfyui', generatorModel: 'z_image_turbo_bf16.safetensors',
    generatorWorkflowHash: 'workflow-sha256', providerRunId: 'prompt-123',
    generationMetadata: { seed: 42, steps: 8 },
  });
  expect(readdirSync(path.join(root, 'backups')).some((name) => name.startsWith('registry-v14-'))).toBe(true);
  migrated.close();
});

function temporaryProjectRoot(): string {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tilemap-generator-db-'));
  temporaryDirectories.push(parent);
  const root = path.join(parent, 'project');
  mkdirSync(root);
  return root;
}

async function writeTransparentPng(root: string, name: string): Promise<string> {
  const output = path.join(root, name);
  await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from('<svg width="32" height="32"><rect width="32" height="32" fill="#657047"/></svg>'), left: 16, top: 16 }])
    .png().toFile(output);
  return output;
}
