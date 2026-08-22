import type { TilemapGeneratorApi } from './bridge';

declare global {
  interface Window {
    tilemap: TilemapGeneratorApi;
  }
}

export {};
