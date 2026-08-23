export const tilemapMcpServerName = 'tilemap_generator';

export const tilemapMcpScopes = [
  'read',
  'project:activate',
  'style:write',
  'references:write',
  'generation:enqueue',
] as const;

export type TilemapMcpScope = typeof tilemapMcpScopes[number];
